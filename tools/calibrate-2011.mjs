// Compare the 2011 scenario against the measured survey heights for a given offshore wave height.
// usage: node tools/calibrate-2011.mjs <offshoreHeightM> [region] [simMinutes] [--present] [--no-buildings]
//   Default: the 当時 option (ground_2011.f32 + the X-shaped old walls). --present: DEM5A + today's walls.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TsunamiSimulator, surveyWaterLevel, surveyFitsTerrain } from '../src/tsunamiSim.js';
import { TSUNAMI_SCENARIOS } from '../src/scenarios.js';
import { SeawallManager } from '../src/seawall.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [heightArg, region = 'taro', minutes = '25'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const era = process.argv.includes('--present') ? 'present' : 'era2011';
const dir = path.join(appRoot, 'public', 'data', 'regions', region);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const buf = fs.readFileSync(path.join(dir, era === 'era2011' && meta.ground2011 ? meta.ground2011.file : 'ground.f32'));
const ground = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const buildings = process.argv.includes('--no-buildings') ? [] : JSON.parse(fs.readFileSync(path.join(dir, 'buildings.json'), 'utf8'));
const survey = JSON.parse(fs.readFileSync(path.join(dir, 'survey2011.json'), 'utf8')).points;

// Seawalls as in the app
const seawallManager = new SeawallManager(meta);
seawallManager.seawallData = JSON.parse(fs.readFileSync(path.join(dir, 'seawalls.json'), 'utf8'));
seawallManager.setEra(era);

const sim = new TsunamiSimulator({ meta, ground, seawallManager, buildings });
sim.setScenario({ ...TSUNAMI_SCENARIOS.great_east_japan, waveHeight: Number(heightArg) });
sim.advance(Number(minutes) * 60);

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
// 5 m mesh agreement (land cells surveyed in the 復興支援調査 5 m inundation mesh)
const meshFile = path.join(dir, 'inund2011_5m.bin');
let mesh5 = null;
if (fs.existsSync(meshFile)) {
  const mb = fs.readFileSync(meshFile);
  const a = new Uint16Array(mb.buffer, mb.byteOffset, mb.byteLength / 2);
  let hit = 0, miss = 0, fa = 0, n = 0, dsum = 0, dsq = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 65535 || ground[i] < 0) continue;
    const unknown = a[i] === 65534; // flooded, depth unknown
    const act = unknown ? Infinity : a[i] / 100;
    const simD = sim.maxDepth[i] >= 0.1 ? sim.maxDepth[i] : 0;
    if (act > 0 && simD > 0) {
      hit++;
      if (!unknown) {
        n++;
        dsum += simD - act;
        dsq += (simD - act) ** 2;
      }
    } else if (act > 0) miss++;
    else if (simD > 0) fa++;
  }
  mesh5 = {
    hitRate: +(hit / (hit + miss)).toFixed(3),
    csi: +(hit / (hit + miss + fa)).toFixed(3),
    falseHa: +((fa * meta.res * meta.res) / 1e4).toFixed(1),
    depthMean: +(dsum / n).toFixed(2),
    depthRmse: +Math.sqrt(dsq / n).toFixed(2),
  };
}

const res = {
  mesh5,
  offshore: Number(heightArg),
  points: survey.length,
  reached,
  within2m: within,
  meanDiff: +(sum / reached).toFixed(2),
  rmse: +Math.sqrt(sq / reached).toFixed(2),
  terrainConsistent,
  maxRunup: +sim.stats.maxRunup.toFixed(1),
  inundatedHa: +sim.stats.inundatedAreaHa.toFixed(1),
};
console.log(JSON.stringify(res));
