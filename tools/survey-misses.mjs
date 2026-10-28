// Where does a CSV-driven run miss the 2011 survey in Taro? Per-point table (CSV) and a map (PNG).
// usage: node tools/survey-misses.mjs <csv> [multiplier] [simMinutes] [outPrefix]
// Map: aerial photo; blue = flooded in 2011 (5 m mesh), orange = flooded in the run, purple = both;
// red line = seawall; points: green |diff| <= 2 m, cyan run lower, magenta run higher, white ring = not reached.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { TsunamiSimulator, surveyWaterLevel, surveyFitsTerrain } from '../src/tsunamiSim.js';
import { WaveProfile } from '../src/waveProfile.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [csvPath, kArg = '1', minutes = '40', outPrefix = 'survey-misses'] = process.argv.slice(2);
globalThis.fetch = async (u) => {
  const p = path.join(appRoot, 'public', u);
  return { json: async () => JSON.parse(fs.readFileSync(p, 'utf8')), arrayBuffer: async () => fs.readFileSync(p).buffer.slice(0) };
};
const { seaDepthAt } = await import('../src/bathyLookup.js');

const dir = path.join(appRoot, 'public', 'data', 'regions', 'taro');
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const { nx, ny, res } = meta;
const N = nx * ny;
const buf = fs.readFileSync(path.join(dir, 'ground.f32'));
const ground = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const buildings = JSON.parse(fs.readFileSync(path.join(dir, 'buildings.json'), 'utf8'));
const survey = JSON.parse(fs.readFileSync(path.join(dir, 'survey2011.json'), 'utf8')).points;

// Seawall as in the app's default preset (old first wall, 10 m)
const barrierGrid = new Float32Array(N).fill(-999);
const barrierActive = new Uint8Array(N);
for (const s of JSON.parse(fs.readFileSync(path.join(dir, 'seawalls.json'), 'utf8')).seawalls.filter((w) => w.type === 'historic')) {
  for (let k = 0; k < s.points.length - 1; k++) {
    const a = s.points[k], b = s.points[k + 1];
    const steps = Math.ceil(Math.hypot(b.e - a.e, b.n - a.n) / (res / 2));
    for (let t = 0; t <= steps; t++) {
      const gx = Math.floor((a.e + ((b.e - a.e) * t) / steps - meta.originE) / res);
      const gz = Math.floor((meta.originN - (a.n + ((b.n - a.n) * t) / steps)) / res);
      if (gx < 0 || gz < 0 || gx >= nx || gz >= ny) continue;
      barrierGrid[gz * nx + gx] = s.defaultHeight;
      barrierActive[gz * nx + gx] = 1;
    }
  }
}

const prof = WaveProfile.parse(fs.readFileSync(csvPath, 'utf8'), path.basename(csvPath));
prof.sourceDepth = await seaDepthAt(prof.lon, prof.lat);
const sim = new TsunamiSimulator({ meta, ground, seawallManager: { barrierGrid, barrierActive }, buildings });
sim.setScenario({ waveHeight: prof.peakHeight, periodSec: 600, directionDeg: prof.dominantDirectionDeg, waveProfile: prof });
sim.setCustomWave({ profileScale: Number(kArg) });
sim.advance(Number(minutes) * 60);
const wet = (i) => sim.maxDepth[i] >= 0.05;

// Land reachable from the sea below the 10 m wall crest without crossing the wall: low ground outside it is behind the wall
const front = new Uint8Array(N);
const queue = [];
for (let i = 0; i < N; i++) if (ground[i] < 0) { front[i] = 1; queue.push(i); }
while (queue.length) {
  const i = queue.pop();
  const x = i % nx, y = (i - x) / nx;
  for (const j of [x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, y > 0 ? i - nx : -1, y < ny - 1 ? i + nx : -1]) {
    if (j < 0 || front[j] || barrierActive[j] || ground[j] >= 10) continue;
    front[j] = 1;
    queue.push(j);
  }
}
// distance to the sea (m), by a multi-source BFS on the grid
const seaDist = new Float32Array(N).fill(Infinity);
const q2 = [];
for (let i = 0; i < N; i++) if (ground[i] < 0) { seaDist[i] = 0; q2.push(i); }
for (let h = 0; h < q2.length; h++) {
  const i = q2[h];
  const x = i % nx, y = (i - x) / nx;
  for (const j of [x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, y > 0 ? i - nx : -1, y < ny - 1 ? i + nx : -1]) {
    if (j < 0 || seaDist[j] !== Infinity) continue;
    seaDist[j] = seaDist[i] + res;
    q2.push(j);
  }
}
const mb = fs.readFileSync(path.join(dir, 'inund2011_5m.bin'));
const act5 = new Uint16Array(mb.buffer, mb.byteOffset, mb.byteLength / 2);

const rows = survey.map((p) => {
  const gx = Math.floor(p.x / res), gz = Math.floor(p.z / res), c = gz * nx + gx;
  const z = ground[c];
  const level = surveyWaterLevel(ground, sim.maxDepth, nx, ny, c);
  const reached = !Number.isNaN(level);
  const simLevel = reached ? level : null;
  // nearest wet land/sea cell within 500 m and the highest simulated level within 50 m
  let near = null, level50 = null;
  for (let r = 0; r <= 100 && near == null; r++) {
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const x = gx + dx, y = gz + dz;
      if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
      const j = y * nx + x;
      if (wet(j)) { const d = Math.hypot(dx, dz) * res; if (near == null || d < near) near = d; }
    }
  }
  for (let dz = -10; dz <= 10; dz++) for (let dx = -10; dx <= 10; dx++) {
    const j = (gz + dz) * nx + gx + dx;
    if (wet(j)) level50 = Math.max(level50 ?? -Infinity, ground[j] + sim.maxDepth[j]);
  }
  const a = act5[c];
  return {
    id: p.id, type: p.type, reliability: p.reliability, lon: p.lon, lat: p.lat,
    measured: p.h, ground: +z.toFixed(2), fitsTerrain: surveyFitsTerrain(p, z), behindWall: z >= 0 && z < 10 && !front[c], seaDistM: Math.round(seaDist[c]),
    flooded2011mesh: a === 65535 ? null : a > 0,
    reached, simLevel: simLevel == null ? null : +simLevel.toFixed(2), diff: simLevel == null ? null : +(simLevel - p.h).toFixed(2),
    nearestWetM: near == null ? null : Math.round(near), simLevelWithin50m: level50 == null ? null : +level50.toFixed(2),
    x: p.x, z: p.z,
  };
});
const cols = Object.keys(rows[0]);
fs.writeFileSync(`${outPrefix}.csv`, '﻿' + [cols.join(','), ...rows.map((r) => cols.map((k) => r[k] ?? '').join(','))].join('\n'));

// Map, cropped to the survey points
const ap = jpeg.decode(fs.readFileSync(path.join(dir, 'aerial.jpg')));
const sx = ap.width / nx, sz = ap.height / ny;
const xs = rows.map((r) => r.x / res), zs = rows.map((r) => r.z / res);
const m = 60;
const x0 = Math.max(0, Math.floor(Math.min(...xs)) - m), x1 = Math.min(nx, Math.ceil(Math.max(...xs)) + m);
const z0 = Math.max(0, Math.floor(Math.min(...zs)) - m), z1 = Math.min(ny, Math.ceil(Math.max(...zs)) + m);
const S = 2; // output pixels per cell
const W = (x1 - x0) * S, H = (z1 - z0) * S;
const png = new PNG({ width: W, height: H });
const put = (px, py, r, g, b, a = 1) => {
  if (px < 0 || py < 0 || px >= W || py >= H) return;
  const o = (py * W + px) * 4;
  png.data[o] = png.data[o] * (1 - a) + r * a;
  png.data[o + 1] = png.data[o + 1] * (1 - a) + g * a;
  png.data[o + 2] = png.data[o + 2] * (1 - a) + b * a;
  png.data[o + 3] = 255;
};
for (let y = z0; y < z1; y++) for (let x = x0; x < x1; x++) {
  const i = y * nx + x;
  const ao = (Math.min(ap.height - 1, Math.floor((y + 0.5) * sz)) * ap.width + Math.min(ap.width - 1, Math.floor((x + 0.5) * sx))) * 4;
  const actWet = act5[i] !== 65535 && act5[i] > 0;
  const simWet = ground[i] >= 0 && sim.maxDepth[i] >= 0.1;
  for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) {
    const px = (x - x0) * S + dx, py = (y - z0) * S + dy;
    put(px, py, ap.data[ao] * 0.7, ap.data[ao + 1] * 0.7, ap.data[ao + 2] * 0.7);
    if (actWet && simWet) put(px, py, 170, 60, 220, 0.55);
    else if (actWet) put(px, py, 40, 140, 255, 0.5);
    else if (simWet) put(px, py, 255, 150, 0, 0.55);
    if (barrierActive[i]) put(px, py, 255, 30, 30, 1);
  }
}
for (const r of rows) {
  const cx = Math.round((r.x / res - x0) * S), cy = Math.round((r.z / res - z0) * S);
  const col = !r.reached ? [255, 255, 255] : Math.abs(r.diff) <= 2 ? [60, 230, 90] : r.diff < 0 ? [0, 230, 255] : [255, 60, 220];
  for (let dy = -9; dy <= 9; dy++) for (let dx = -9; dx <= 9; dx++) {
    const d = Math.hypot(dx, dy);
    if (!r.reached ? d >= 6 && d <= 9 : d <= 7) put(cx + dx, cy + dy, ...col, 1);
    else if (d <= 9.6 && d > (r.reached ? 7 : 9)) put(cx + dx, cy + dy, 0, 0, 0, 1);
  }
}
fs.writeFileSync(`${outPrefix}.png`, PNG.sync.write(png));

const nr = rows.filter((r) => !r.reached);
console.log(`reached ${rows.length - nr.length}/${rows.length}; not reached: ${nr.length} (R ${nr.filter((r) => r.type === 'R').length}, I ${nr.filter((r) => r.type === 'I').length}; behind wall ${nr.filter((r) => r.behindWall).length}; inside the 2011 flooded mesh ${nr.filter((r) => r.flooded2011mesh).length})`);
console.log(`wrote ${outPrefix}.csv / .png`);
