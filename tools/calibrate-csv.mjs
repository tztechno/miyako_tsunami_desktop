// Compare a run driven by a wave CSV (e.g. nankai_trough's 2011 output) with the 59 surveyed 2011 heights in Taro.
// usage: node tools/calibrate-csv.mjs <csv> [multiplier] [simMinutes] [region]
// The boundary level is CSV × automatic shoaling correction (depth at the CSV point → edge) × multiplier, as in the app.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TsunamiSimulator, surveyWaterLevel, surveyFitsTerrain } from '../src/tsunamiSim.js';
import { WaveProfile } from '../src/waveProfile.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [csvPath, kArg = '1', minutes = '40', region = 'taro'] = process.argv.slice(2);
// serve the bathymetry grid to bathyLookup's fetch from disk
globalThis.fetch = async (u) => {
  const p = path.join(appRoot, 'public', u);
  return { json: async () => JSON.parse(fs.readFileSync(p, 'utf8')), arrayBuffer: async () => fs.readFileSync(p).buffer.slice(0) };
};
const { seaDepthAt } = await import('../src/bathyLookup.js');

const dir = path.join(appRoot, 'public', 'data', 'regions', region);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const buf = fs.readFileSync(path.join(dir, 'ground.f32'));
const ground = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const buildings = JSON.parse(fs.readFileSync(path.join(dir, 'buildings.json'), 'utf8'));
const survey = JSON.parse(fs.readFileSync(path.join(dir, 'survey2011.json'), 'utf8')).points;

// Seawall as in the app's default preset (old first wall, 10 m)
const N = meta.nx * meta.ny;
const barrierGrid = new Float32Array(N).fill(-999);
const barrierActive = new Uint8Array(N);
const sw = JSON.parse(fs.readFileSync(path.join(dir, 'seawalls.json'), 'utf8')).seawalls.filter((s) => s.type === 'historic');
for (const s of sw) {
  for (let k = 0; k < s.points.length - 1; k++) {
    const a = s.points[k], b = s.points[k + 1];
    const steps = Math.ceil(Math.hypot(b.e - a.e, b.n - a.n) / (meta.res / 2));
    for (let t = 0; t <= steps; t++) {
      const gx = Math.floor((a.e + ((b.e - a.e) * t) / steps - meta.originE) / meta.res);
      const gz = Math.floor((meta.originN - (a.n + ((b.n - a.n) * t) / steps)) / meta.res);
      if (gx < 0 || gz < 0 || gx >= meta.nx || gz >= meta.ny) continue;
      barrierGrid[gz * meta.nx + gx] = s.defaultHeight;
      barrierActive[gz * meta.nx + gx] = 1;
    }
  }
}

const prof = WaveProfile.parse(fs.readFileSync(csvPath, 'utf8'), path.basename(csvPath));
prof.sourceDepth = await seaDepthAt(prof.lon, prof.lat);
const sim = new TsunamiSimulator({ meta, ground, seawallManager: { barrierGrid, barrierActive }, buildings });
sim.setScenario({ waveHeight: prof.peakHeight, periodSec: 600, directionDeg: prof.dominantDirectionDeg, waveProfile: prof });
sim.setCustomWave({ profileScale: Number(kArg) });
sim.advance(Number(minutes) * 60);
sim.updateStats();

const cells = survey.map((p) => Math.floor(p.z / meta.res) * meta.nx + Math.floor(p.x / meta.res));
let reached = 0, within = 0, sum = 0, sq = 0;
// the same for the points that agree with today's terrain (surveyFitsTerrain)
const fit = { points: 0, reached: 0, within2m: 0, sum: 0, sq: 0 };
for (let k = 0; k < survey.length; k++) {
  const fits = surveyFitsTerrain(survey[k], ground[cells[k]]);
  if (fits) fit.points++;
  const level = surveyWaterLevel(ground, sim.maxDepth, meta.nx, meta.ny, cells[k]);
  if (Number.isNaN(level)) continue;
  const diff = level - survey[k].h;
  reached++;
  sum += diff;
  sq += diff * diff;
  if (Math.abs(diff) <= 2) within++;
  if (fits) {
    fit.reached++;
    fit.sum += diff;
    fit.sq += diff * diff;
    if (Math.abs(diff) <= 2) fit.within2m++;
  }
}
const terrainConsistent = {
  points: fit.points,
  reached: fit.reached,
  within2m: fit.within2m,
  meanDiff: +(fit.sum / fit.reached).toFixed(2),
  rmse: +Math.sqrt(fit.sq / fit.reached).toFixed(2),
};
console.log(JSON.stringify({
  csv: path.basename(csvPath),
  sourceDepth: +prof.sourceDepth?.toFixed(0),
  edgeDepth: +sim.bcDepth.toFixed(0),
  directionFrom: prof.dominantDirectionDeg,
  shoaling: +sim.shoalFactor.toFixed(3),
  multiplier: Number(kArg),
  total: +(sim.shoalFactor * Number(kArg)).toFixed(3),
  boundaryPeak: +(prof.peakHeight * sim.shoalFactor * Number(kArg)).toFixed(2),
  points: survey.length,
  reached,
  notReached: survey.length - reached,
  within2m: within,
  meanDiff: +(sum / reached).toFixed(2),
  rmse: +Math.sqrt(sq / reached).toFixed(2),
  terrainConsistent,
  maxRunup: +sim.stats.maxRunup.toFixed(1),
  inundatedHa: +sim.stats.inundatedAreaHa.toFixed(1),
}));
