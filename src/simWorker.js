/**
 * Runs the tsunami simulation off the main thread so the UI and 3D view stay responsive.
 * Posts downsampled render frames (eta / depth / foam) plus stats; frame buffers are
 * recycled between threads to avoid per-frame allocations.
 */
import { TsunamiSimulator } from './tsunamiSim.js';

const FRAME_BUDGET_MS = 30; // wall time spent stepping between posted frames
const MAX_POOL = 3;

let sim = null;
let barriers = null;
let step = 2;
let wnx = 0;
let wny = 0;
let playing = false;
let point = null;
let surveyCells = null; // Int32Array of sim cell indices for the 2011 survey points
const pool = [];
let allocated = 0;

function allocFrame() {
  const n = wnx * wny;
  return {
    eta: new Float32Array(n),
    depth: new Float32Array(n),
    maxDepth: new Float32Array(n),
    foam: new Uint8Array(n),
    bldgWet: new Uint8Array(sim.buildings.length),
  };
}

function takeFrame(force) {
  if (pool.length) return pool.pop();
  if (allocated < MAX_POOL || force) {
    allocated++;
    return allocFrame();
  }
  return null; // main thread still holds every buffer; skip this post
}

let prevEta = null;
let prevTime = 0;

function fillFrame(f) {
  const { nx, ny, res, eta, depth, qx, qy, ground } = sim;
  if (!prevEta || prevEta.length !== wnx * wny || sim.simTimeSec < prevTime) {
    prevEta = new Float32Array(wnx * wny);
    for (let j = 0; j < wny; j++) for (let i = 0; i < wnx; i++) prevEta[j * wnx + i] = eta[Math.min(ny - 1, j * step) * nx + Math.min(nx - 1, i * step)];
    prevTime = sim.simTimeSec;
  }
  const dtPost = sim.simTimeSec - prevTime;
  for (let j = 0; j < wny; j++) {
    const sy = Math.min(ny - 1, j * step);
    for (let i = 0; i < wnx; i++) {
      const sx = Math.min(nx - 1, i * step);
      const s = sy * nx + sx;
      const v = j * wnx + i;
      const d = depth[s];
      f.eta[v] = eta[s];
      f.depth[v] = d;
      f.maxDepth[v] = sim.maxDepth[s];
      // Foam = supercritical-ish flow (bores, overland surge, overtopping jets).
      // Froude-based so the deep, fast-but-smooth offshore swell stays clear water.
      let foam = 0;
      if (d > 0.05) {
        const u = 0.5 * (qx[s] + (sx > 0 ? qx[s - 1] : qx[s])) / d;
        const w = 0.5 * (qy[s] + (sy > 0 ? qy[s - nx] : qy[s])) / d;
        const fr = Math.hypot(u, w) / Math.sqrt(9.80665 * d);
        foam = Math.max(0, Math.min(1, (fr - 0.6) / 0.9));
        if (d > 5) foam *= Math.max(0, 1 - (d - 5) / 5);
        if (ground[s] < 0) foam *= 0.7;
        // Leading edge of the surge: water level rising fast
        if (dtPost > 0.5) {
          const rise = (eta[s] - prevEta[v]) / dtPost;
          foam = Math.max(foam, Math.min(0.85, Math.max(0, (rise - 0.04) / 0.12)));
        }
      }
      if (dtPost > 0.5) prevEta[v] = eta[s];
      f.foam[v] = Math.round(foam * 255);
    }
  }
  if (dtPost > 0.5) prevTime = sim.simTimeSec;
  const b = sim.buildings;
  for (let k = 0; k < b.length; k++) {
    const gx = Math.floor(b[k].x / res);
    const gz = Math.floor(b[k].z / res);
    f.bldgWet[k] = gx >= 0 && gx < nx && gz >= 0 && gz < ny && depth[gz * nx + gx] >= 0.5 ? 1 : 0;
  }
}

function post(reqId, force = false) {
  const f = takeFrame(force);
  if (!f) return false;
  fillFrame(f);
  sim.updateStats();
  const pt = point ? sim.getPointDepth(point.worldX, point.worldZ) : null;
  // Simulated maximum water level (T.P.) at each survey point; NaN where the water never arrived
  let surveyMax = null;
  if (surveyCells) {
    surveyMax = new Float32Array(surveyCells.length);
    for (let k = 0; k < surveyCells.length; k++) {
      const c = surveyCells[k];
      const md = sim.maxDepth[c];
      surveyMax[k] = sim.ground[c] >= 0 && md < 0.05 ? NaN : sim.ground[c] + md;
    }
  }
  self.postMessage(
    { type: 'frame', reqId, frame: f, stats: { ...sim.stats }, simTimeSec: sim.simTimeSec, point: pt, surveyMax },
    [f.eta.buffer, f.depth.buffer, f.maxDepth.buffer, f.foam.buffer, f.bldgWet.buffer]
  );
  return true;
}

/**
 * Batch run: reset, run to `end` seconds without waiting for the UI, sample points every
 * `sampleEvery` s, then send the time series and the final max-depth / arrival grids.
 */
let batch = null;

function sampleBatch() {
  const row = new Float32Array(1 + batch.cells.length * 2);
  row[0] = sim.getOffshoreWaveEta(sim.simTimeSec);
  batch.cells.forEach((c, k) => {
    row[1 + k * 2] = sim.depth[c];
    row[2 + k * 2] = sim.eta[c];
  });
  batch.times.push(sim.simTimeSec);
  batch.rows.push(row);
  batch.nextSample += batch.sampleEvery;
}

function runBatch() {
  if (!batch) return;
  if (batch.cancelled) {
    self.postMessage({ type: 'batchDone', reqId: batch.reqId, cancelled: true });
    batch = null;
    return;
  }
  const t0 = performance.now();
  while (sim.simTimeSec < batch.end - 1e-6 && performance.now() - t0 < 120) {
    if (sim.simTimeSec >= batch.nextSample - 1e-6) sampleBatch();
    sim.step(Math.min(sim.stableDt(), batch.end - sim.simTimeSec));
  }
  post(null); // keep the 3D view and progress up to date
  if (sim.simTimeSec < batch.end - 1e-6) {
    setTimeout(runBatch, 0);
    return;
  }
  sampleBatch();
  sim.logSnapshot();
  const maxDepth = sim.maxDepth.slice();
  const arrival = sim.arrival.slice();
  self.postMessage(
    {
      type: 'batchDone',
      reqId: batch.reqId,
      summaryCsv: sim.generateCSV(),
      times: batch.times,
      rows: batch.rows,
      maxDepth,
      arrival,
    },
    [maxDepth.buffer, arrival.buffer]
  );
  batch = null;
}

function tick() {
  if (!playing || !sim) return;
  const t0 = performance.now();
  do {
    sim.step(sim.stableDt());
  } while (performance.now() - t0 < FRAME_BUDGET_MS);
  post(null);
  setTimeout(tick, 0);
}

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      step = m.renderStep;
      wnx = Math.floor(m.meta.nx / step);
      wny = Math.floor(m.meta.ny / step);
      barriers = { barrierGrid: m.barrierGrid, barrierActive: m.barrierActive };
      sim = new TsunamiSimulator({ meta: m.meta, ground: m.ground, seawallManager: barriers, buildings: m.buildings });
      pool.length = 0;
      allocated = 0;
      playing = false;
      post(null, true);
      break;
    }
    case 'barriers':
      barriers.barrierGrid = m.barrierGrid;
      barriers.barrierActive = m.barrierActive;
      break;
    case 'scenario':
      sim.setScenario(m.scenario);
      post(null, true);
      break;
    case 'customWave':
      sim.setCustomWave(m.params);
      break;
    case 'reset':
      sim.reset();
      post(null, true);
      break;
    case 'play':
      if (!playing) {
        playing = true;
        tick();
      }
      break;
    case 'pause':
      playing = false;
      break;
    case 'point':
      point = m.point;
      break;
    case 'survey':
      surveyCells = m.cells;
      break;
    case 'advance':
      // Deterministic stepping for video recording
      sim.advance(m.seconds);
      post(m.reqId, true);
      break;
    case 'recycle':
      if (m.frame && m.frame.eta.length === wnx * wny && pool.length < MAX_POOL) pool.push(m.frame);
      break;
    case 'batch':
      playing = false;
      sim.reset();
      batch = { reqId: m.reqId, end: m.durationSec, cells: m.cells, sampleEvery: m.sampleEvery, nextSample: 0, times: [], rows: [], cancelled: false };
      runBatch();
      break;
    case 'batchCancel':
      if (batch) batch.cancelled = true;
      break;
    case 'csv':
      self.postMessage({ type: 'csv', reqId: m.reqId, csv: sim.generateCSV() });
      break;
  }
};
