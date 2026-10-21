// Headless benchmark / stability check for the tsunami simulator.
// usage: node tools/bench-sim.mjs [region] [scenarioId] [simMinutes] [dt]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TsunamiSimulator, WaveProfile } from '../src/tsunamiSim.js';
import { TSUNAMI_SCENARIOS } from '../src/scenarios.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [region = 'taro', scId = 'great_east_japan', minutes = '30', dtArg] = process.argv.slice(2);
const dir = path.join(appRoot, 'public', 'data', 'regions', region);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const buf = fs.readFileSync(path.join(dir, 'ground.f32'));
const ground = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const buildings = JSON.parse(fs.readFileSync(path.join(dir, 'buildings.json'), 'utf8'));

const N = meta.nx * meta.ny;
const seawallManager = { barrierGrid: new Float32Array(N).fill(-999), barrierActive: new Uint8Array(N) };
const sim = new TsunamiSimulator({ meta, ground, seawallManager, buildings });

const sc = { ...TSUNAMI_SCENARIOS[scId] };
if (sc.csvUrl) {
  const cleanUrl = sc.csvUrl.replace(/^\.\//, '');
  const csvPath = path.join(appRoot, 'public', cleanUrl);
  if (fs.existsSync(csvPath)) {
    const csvText = fs.readFileSync(csvPath, 'utf8');
    sc.waveProfile = WaveProfile.parse(csvText, path.basename(csvPath));
    console.log(`Loaded wave CSV: ${sc.waveProfile.name}, peak: ${sc.waveProfile.peakHeight.toFixed(2)}m at ${sc.waveProfile.peakTimeSec}s`);
  }
}
sim.setScenario(sc);

const endSec = Number(minutes) * 60;
const t0 = performance.now();
let steps = 0;
let nextReport = 0;
while (sim.simTimeSec < endSec) {
  if (dtArg) sim.step(Number(dtArg)); else sim.advance(1.5);
  steps++;
  if (sim.simTimeSec >= nextReport) {
    nextReport += 120;
    let nan = 0, maxEta = -1e9, maxAt = -1, wetLand = 0, vol = 0;
    for (let i = 0; i < N; i++) {
      if (!Number.isFinite(sim.eta[i])) nan++;
      else if (sim.depth[i] > 0.05) {
        vol += sim.depth[i];
        if (sim.eta[i] > maxEta) { maxEta = sim.eta[i]; maxAt = i; }
        if (ground[i] >= 0) wetLand++;
      }
    }
    const at = `(${maxAt % meta.nx},${Math.floor(maxAt / meta.nx)} zb=${ground[maxAt]?.toFixed(1)})`;
    console.log(`t=${(sim.simTimeSec / 60).toFixed(1)}min offshore=${sim.stats.offshoreWaveHeight.toFixed(2)} maxEta=${maxEta.toFixed(2)}${at} wetLandHa=${(wetLand * meta.res * meta.res / 1e4).toFixed(1)} runup=${sim.stats.maxRunup.toFixed(1)} vol=${(vol * meta.res * meta.res / 1e6).toFixed(2)}Mm3 dt=${sim.stableDt().toFixed(3)} nan=${nan}`);
  }
}
const ms = performance.now() - t0;
console.log(`steps=${steps} total=${(ms / 1000).toFixed(1)}s per-call=${(ms / steps).toFixed(1)}ms`);
