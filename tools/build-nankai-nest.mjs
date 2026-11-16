/**
 * Nested 15 arc-second grid of the Miyako / Taro coast for the in-app fault run (src/faultWorker.js): the same
 * window of japan.tif as tools/nankai/run-nankai.ts, written as Int16 (m, NoData -> +1 land) with the
 * BathymetryMeta of nankai_trough's NestedGrid.
 *
 *   node tools/build-nankai-nest.mjs ../DOCS/japan.tif
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromFile } from 'geotiff';

export const NEST = { lonMin: 141.85, lonMax: 142.4, latMin: 39.45, latMax: 40.0 };

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tif = process.argv[2];
if (!tif) throw new Error('usage: node tools/build-nankai-nest.mjs path/to/japan.tif');
const img = await (await fromFile(tif)).getImage();
const [ox, oy] = img.getOrigin();
const [rx, ry] = img.getResolution();
const x0 = Math.round((NEST.lonMin - ox) / rx), x1 = Math.round((NEST.lonMax - ox) / rx);
const y0 = Math.round((NEST.latMax - oy) / ry), y1 = Math.round((NEST.latMin - oy) / ry);
const [raw] = await img.readRasters({ window: [x0, y0, x1, y1] });
const nodata = Number(img.getGDALNoData());
const fine = Int16Array.from(raw, (v) => (v === nodata ? 1 : v));
const W = x1 - x0, H = y1 - y0;
const bounds = { lonMin: ox + x0 * rx, lonMax: ox + x1 * rx, latMin: oy + y1 * ry, latMax: oy + y0 * ry };
const meta = {
  width: W, height: H, factor: 1, bounds, dxDeg: rx, dyDeg: -ry,
  dxMeters: rx * 111320 * Math.cos((39.7 * Math.PI) / 180), dyMeters: -ry * 111000,
  source: 'japan.tif (15 arc-second topography + bathymetry)',
};
const outDir = path.join(appRoot, 'public', 'data', 'nankai');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'nest_miyako.bin'), Buffer.from(fine.buffer));
fs.writeFileSync(path.join(outDir, 'nest_miyako_meta.json'), JSON.stringify(meta, null, 2));
console.log(`nest_miyako: ${W}x${H}, ${bounds.lonMin.toFixed(3)}-${bounds.lonMax.toFixed(3)}E ${bounds.latMin.toFixed(3)}-${bounds.latMax.toFixed(3)}N`);
