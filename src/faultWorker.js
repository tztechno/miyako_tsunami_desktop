/**
 * In-app tsunami source from a fault CSV (the Shizuoka method of N81_shizuoka_tsunami, done in the browser):
 * nankai_trough's solver (src/nankai/, copied from N73) runs Japan on its 2.5 km grid with the Miyako / Taro coast
 * nested at 15 arc-seconds (public/data/nankai/nest_miyako.bin), recording the water level at stations every 1 km
 * along each region's inflow edges (src/edgePath.js, as tools/nankai/run-nankai.ts). The result per region:
 *   edges    { p, dtSec, count, eta }  waveforms fed in at the edge where they were sampled (no shoaling correction),
 *            raw levels: the coseismic change at the edges is kept because the uplift below moves the sea inside
 *   uplift   { nx, ny, stepM, data, onsetSec, riseSec }  sea-surface displacement over the region (land kept fixed)
 *   csv      the middle station in nankai_trough's CSV format, for the app's CSV badge and preview
 *
 * Messages in:  { type: 'run', faults, rupture, durationSec, urls: { bathy, bathyMeta, nest, nestMeta }, regions: [meta] }
 *               { type: 'cancel' }
 * Messages out: { type: 'progress', t, durationSec } / { type: 'done', results } / { type: 'error', message }
 */
import { ShallowWaterSolver } from './nankai/physics/shallowWater';
import { NestedGrid } from './nankai/physics/nestedGrid';
import { computeInitialDisplacementGrid } from './nankai/physics/okada';
import { toLonLat } from './proj.js';
import { edgeSegments, edgePoint } from './edgePath.js';

const STATION_STEP_M = 1000;
const INSET_M = 200;
const EDGE_DT_SEC = 6;
const UPLIFT_STEP_M = 240;
const RISE_SEC = 60; // nankai_trough's rupture rise time

let cancelled = false;

const loadBin = async (url) => new Int16Array(await (await fetch(url)).arrayBuffer());
const loadJson = async (url) => (await fetch(url)).json();

function csvText(pt, name) {
  const row = (r) => `${r.timeSec.toFixed(1)},${r.elevation.toFixed(3)},${r.u.toFixed(3)},${r.v.toFixed(3)},${r.speed.toFixed(3)},${r.directionDeg.toFixed(1)}`;
  return [
    '# Tsunami Wave Boundary Condition for Phase 2 Simulation (Full Timeline)',
    `# Location: ${name} (Lon: ${pt.lon}, Lat: ${pt.lat})`,
    `# Max Wave Height: ${pt.maxWaveHeight ?? 0} m, First Arrival: ${pt.firstArrivalSec ?? 'N/A'} s`,
    'Time_sec,Elevation_m,U_velocity_m_s,V_velocity_m_s,Speed_m_s,Direction_deg',
    ...pt.timeHistory.map(row),
  ].join('\r\n');
}

async function run(m) {
  cancelled = false;
  const [bathy, meta, fine, nestMeta] = await Promise.all([loadBin(m.urls.bathy), loadJson(m.urls.bathyMeta), loadBin(m.urls.nest), loadJson(m.urls.nestMeta)]);
  const nb = nestMeta.bounds;
  const seaAt = (lon, lat) => {
    const i = Math.floor((lon - nb.lonMin) / nestMeta.dxDeg), j = Math.floor((nb.latMax - lat) / nestMeta.dyDeg);
    return i >= 0 && j >= 0 && i < nestMeta.width && j < nestMeta.height && fine[j * nestMeta.width + i] < -5;
  };

  // stations along each region's inflow edges, in edge order
  const stations = [];
  for (const reg of m.regions) {
    const segs = edgeSegments(reg);
    const total = segs.reduce((s, g) => s + g.len, 0);
    for (let p = STATION_STEP_M / 2; p < total; p += STATION_STEP_M) {
      const { x, z } = edgePoint(reg, segs, p, INSET_M);
      const [lon, lat] = toLonLat(reg.originE + x, reg.originN - z);
      if (seaAt(lon, lat)) stations.push({ id: `${reg.name}_${stations.length}`, region: reg.name, name: `${reg.name} edge`, lon: +lon.toFixed(5), lat: +lat.toFixed(5), p, color: '#fff' });
    }
  }

  const solver = new ShallowWaterSolver(meta, bathy, 3.0);
  const nest = new NestedGrid('miyako', nestMeta, fine, solver, meta);
  nest.observationPoints = stations;
  const faults = JSON.parse(JSON.stringify(m.faults));
  const b = meta.bounds;
  solver.resetWithDisplacement(computeInitialDisplacementGrid(faults, meta.width, meta.height, b.lonMin, b.lonMax, b.latMin, b.latMax), m.rupture || undefined);
  const nestEta = computeInitialDisplacementGrid(faults, nestMeta.width, nestMeta.height, nb.lonMin, nb.lonMax, nb.latMin, nb.latMax);
  nest.reset(nestEta, m.rupture || undefined);

  // step in slices so a cancel message gets through
  await new Promise((resolve) => {
    let lastPost = 0;
    const slice = () => {
      if (cancelled) return resolve();
      const t0 = performance.now();
      while (solver.currentTimeSec < m.durationSec && performance.now() - t0 < 200) { solver.step(); nest.step(); }
      if (performance.now() - lastPost > 500) {
        lastPost = performance.now();
        self.postMessage({ type: 'progress', t: solver.currentTimeSec, durationSec: m.durationSec });
      }
      if (solver.currentTimeSec >= m.durationSec) resolve();
      else setTimeout(slice, 0);
    };
    slice();
  });
  if (cancelled) { self.postMessage({ type: 'cancelled' }); return; }

  // sea-surface displacement at a point (bilinear on the nested grid's corner values)
  const W = nestMeta.width, H = nestMeta.height;
  const dispAt = (lon, lat) => {
    const fc = ((lon - nb.lonMin) / (nb.lonMax - nb.lonMin)) * W, fr = ((nb.latMax - lat) / (nb.latMax - nb.latMin)) * H;
    const c = Math.max(0, Math.min(W - 1, Math.floor(fc))), r = Math.max(0, Math.min(H - 1, Math.floor(fr)));
    const tc = Math.max(0, Math.min(1, fc - c)), tr = Math.max(0, Math.min(1, fr - r));
    // grid values sit on the corners (lonMin + c dLon, latMax - r dLat), width x height of them (as build-uplift.ts)
    const g = (rr, cc) => nestEta[Math.min(H - 1, rr) * W + Math.min(W - 1, cc)];
    return (g(r, c) * (1 - tc) + g(r, c + 1) * tc) * (1 - tr) + (g(r + 1, c) * (1 - tc) + g(r + 1, c + 1) * tc) * tr;
  };

  const results = {};
  for (const reg of m.regions) {
    const st = stations.filter((s) => s.region === reg.name).sort((a, c) => a.p - c.p);
    if (!st.length || !st[0].timeHistory?.length) continue;
    const hist = st[0].timeHistory, dt0 = hist[1].timeSec - hist[0].timeSec, every = Math.max(1, Math.round(EDGE_DT_SEC / dt0));
    const n = Math.floor(hist.length / every);
    const eta = new Float32Array(st.length * n);
    st.forEach((s, k) => { for (let q = 0; q < n; q++) eta[k * n + q] = s.timeHistory[q * every].elevation; });
    // displacement over the region, region-local metres from the NW corner
    const unx = Math.ceil((reg.nx * reg.res) / UPLIFT_STEP_M) + 1, uny = Math.ceil((reg.ny * reg.res) / UPLIFT_STEP_M) + 1;
    const data = new Float32Array(unx * uny);
    let umin = Infinity, umax = -Infinity;
    for (let j = 0; j < uny; j++) for (let i = 0; i < unx; i++) {
      const [lon, lat] = toLonLat(reg.originE + i * UPLIFT_STEP_M, reg.originN - j * UPLIFT_STEP_M);
      const v = dispAt(lon, lat);
      data[j * unx + i] = v;
      umin = Math.min(umin, v); umax = Math.max(umax, v);
    }
    const [clon, clat] = toLonLat(reg.originE + (reg.nx * reg.res) / 2, reg.originN - (reg.ny * reg.res) / 2);
    const km = m.rupture ? Math.hypot((clon - m.rupture.lon) * 85.4, (clat - m.rupture.lat) * 111.0) : 0;
    const onsetSec = m.rupture ? Math.round(km / m.rupture.velocityKmS) : 0;
    const mid = st[Math.floor(st.length / 2)];
    results[reg.name] = {
      edges: { p: st.map((s) => s.p), dtSec: every * dt0, count: n, eta },
      uplift: { nx: unx, ny: uny, stepM: UPLIFT_STEP_M, data, onsetSec, riseSec: m.rupture?.riseTimeSec || RISE_SEC, min: umin, max: umax },
      csv: csvText(mid, `断層CSVの波源 計算域の縁 (${reg.name})`),
      edgeMax: [Math.min(...st.map((s) => s.maxWaveHeight ?? 0)), Math.max(...st.map((s) => s.maxWaveHeight ?? 0))],
      stations: st.length,
    };
  }
  self.postMessage({ type: 'done', results });
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'cancel') cancelled = true;
  else if (m.type === 'run') run(m).catch((err) => self.postMessage({ type: 'error', message: err.message || String(err) }));
};
