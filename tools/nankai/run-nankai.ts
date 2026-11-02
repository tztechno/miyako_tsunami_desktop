/**
 * Headless run of the nankai_trough solver (../../N73_nankai_trough) with the Miyako / Taro coast on a nested
 * 15 arc-second grid (japan.tif, its one-way NestedGrid), sampling stations every 1 km along each region's inflow
 * edges (src/edgePath.js) and nankai_trough's own points off Miyako; writes the time histories as JSON for
 * tools/build-wave-sources.mjs. The same method as N81_shizuoka_tsunami (WAVE_SOURCE.ja.md).
 *
 *   npx esbuild tools/nankai/run-nankai.ts --bundle --platform=node --format=esm --external:geotiff --external:proj4 --outfile=.cache/run-nankai.mjs
 *   node .cache/run-nankai.mjs tohoku_2011_m90 10800 .cache/nankai_tohoku_2011_m90.json
 */
import fs from 'node:fs';
import { fromFile } from 'geotiff';
import { ShallowWaterSolver } from '../../../../N73_nankai_trough/nankai_trough/src/physics/shallowWater';
import { NestedGrid } from '../../../../N73_nankai_trough/nankai_trough/src/physics/nestedGrid';
import { computeInitialDisplacementGrid } from '../../../../N73_nankai_trough/nankai_trough/src/physics/okada';
import { FAULT_PRESETS } from '../../../../N73_nankai_trough/nankai_trough/src/data/presets';
import { toLonLat } from '../lib/proj.mjs';
import { edgeSegments, edgePoint } from '../../src/edgePath.js';

const NEST = { lonMin: 141.85, lonMax: 142.4, latMin: 39.45, latMax: 40.0 };
const REGIONS = ['taro', 'miyako_port'];
const STATION_STEP_M = 1000;
const INSET_M = 200; // inside the forced boundary
// run from miyako_tsunami/ (N73_nankai_trough sits next to N72_miyako_tsunami)
const root = '../../N73_nankai_trough/nankai_trough/public/';
const meta = JSON.parse(fs.readFileSync(root + 'bathymetry_meta.json', 'utf8'));
const buf = fs.readFileSync(root + 'bathymetry.bin');
const bathy = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);

const img = await (await fromFile('../DOCS/japan.tif')).getImage();
const [ox, oy] = img.getOrigin();
const [rx, ry] = img.getResolution();
const x0 = Math.round((NEST.lonMin - ox) / rx), x1 = Math.round((NEST.lonMax - ox) / rx);
const y0 = Math.round((NEST.latMax - oy) / ry), y1 = Math.round((NEST.latMin - oy) / ry);
const [raw] = await img.readRasters({ window: [x0, y0, x1, y1] });
const nodata = Number(img.getGDALNoData());
const fine = Int16Array.from(raw as any, (v: number) => (v === nodata ? 1 : v));
const W = x1 - x0, H = y1 - y0;
const bounds = { lonMin: ox + x0 * rx, lonMax: ox + x1 * rx, latMin: oy + y1 * ry, latMax: oy + y0 * ry };
const nestMeta = {
  width: W, height: H, factor: 1, bounds, dxDeg: rx, dyDeg: -ry,
  dxMeters: rx * 111320 * Math.cos((39.7 * Math.PI) / 180), dyMeters: -ry * 111000,
};
const seaAt = (lon: number, lat: number) => fine[Math.floor((bounds.latMax - lat) / -ry) * W + Math.floor((lon - bounds.lonMin) / rx)] < -5;

/** Stations every STATION_STEP_M along each region's inflow edges (sea only), with their p along the edges. */
function edgeStations() {
  const out: any[] = [];
  for (const region of REGIONS) {
    const reg = JSON.parse(fs.readFileSync(`public/data/regions/${region}/meta.json`, 'utf8'));
    const segs = edgeSegments(reg);
    const total = segs.reduce((s, g) => s + g.len, 0);
    for (let p = STATION_STEP_M / 2; p < total; p += STATION_STEP_M) {
      const { x, z } = edgePoint(reg, segs, p, INSET_M);
      const [lon, lat] = toLonLat(reg.originE + x, reg.originN - z);
      if (seaAt(lon, lat)) out.push({ id: `${region}_${out.length}`, region, name: `${region} edge`, lon: +lon.toFixed(5), lat: +lat.toFixed(5), p, color: '#fff' });
    }
  }
  return out;
}

const ids = (process.argv[2] || '').split(',').filter(Boolean);
const durationSec = +(process.argv[3] || 10800);
const out = process.argv[4];
const results: any = {};
for (const sc of FAULT_PRESETS.filter((s) => !ids.length || ids.includes(s.id))) {
  const solver = new ShallowWaterSolver(meta, bathy, 3.0);
  const nest = new NestedGrid('miyako', nestMeta as any, fine, solver, meta);
  const stations = edgeStations();
  const pts: any[] = [
    // nankai_trough's own preset points
    { id: 'miyako', name: '宮古沖 (岩手)', lon: 142.19, lat: 39.63, color: '#fff' },
    { id: 'taro', name: '田老沖 (岩手)', lon: 142.07, lat: 39.74, color: '#fff' },
    { id: 'miyako_bay', name: '宮古湾口沖 (岩手)', lon: 142.01, lat: 39.69, color: '#fff' },
    ...stations,
  ];
  solver.observationPoints = [];
  nest.observationPoints = pts;
  const faults = JSON.parse(JSON.stringify(sc.faults));
  const rupture = sc.rupture && sc.hypocenter ? { lon: sc.hypocenter.lon, lat: sc.hypocenter.lat, ...sc.rupture } : undefined;
  const b = meta.bounds;
  solver.resetWithDisplacement(computeInitialDisplacementGrid(faults, meta.width, meta.height, b.lonMin, b.lonMax, b.latMin, b.latMax), rupture);
  nest.reset(computeInitialDisplacementGrid(faults, W, H, bounds.lonMin, bounds.lonMax, bounds.latMin, bounds.latMax), rupture);
  const t0 = Date.now();
  while (solver.currentTimeSec < durationSec) { solver.step(); nest.step(); }
  results[sc.id] = { name: sc.name, points: pts };
  console.log(sc.id, ((Date.now() - t0) / 1000).toFixed(0) + 's', `${stations.length} stations`);
  for (const p of pts) console.log(`  ${p.id.padEnd(15)} ${String(p.lon).padEnd(9)} ${String(p.lat).padEnd(9)} p=${String(p.p ?? '').padEnd(6)} first ${p.timeHistory[0]?.elevation?.toFixed(2)} max ${p.maxWaveHeight} @${(p.maxArrivalSec / 60).toFixed(1)}min min ${p.minWaveHeight}`);
}
if (out) fs.writeFileSync(out, JSON.stringify(results));
