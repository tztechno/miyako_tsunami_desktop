// Depth grid off Sanriku from japan.tif (15 arc-second, int16 m) for looking up the depth at a wave CSV point
// in the browser (shoaling correction). usage: node tools/build-bathy-grid.mjs [lonMin lonMax latMin latMax]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromFile } from 'geotiff';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tifPath = [path.resolve(appRoot, '..', 'japan.tif'), path.resolve(appRoot, '..', 'DOCS', 'japan.tif')].find((p) => fs.existsSync(p));
const [lonMin, lonMax, latMin, latMax] = (process.argv.length >= 6 ? process.argv.slice(2, 6) : [141.5, 144.5, 38.5, 41.0]).map(Number);
const outDir = path.join(appRoot, 'public', 'data', 'bathy');

const image = await (await fromFile(tifPath)).getImage();
const [ox, oy] = image.getOrigin();
const [rx, ry] = image.getResolution();
const x0 = Math.floor((lonMin - ox) / rx), x1 = Math.ceil((lonMax - ox) / rx);
const y0 = Math.floor((latMax - oy) / ry), y1 = Math.ceil((latMin - oy) / ry);
const [raw] = await image.readRasters({ window: [x0, y0, x1, y1] });

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'sanriku_15s.bin'), Buffer.from(Int16Array.from(raw).buffer));
const meta = {
  source: 'japan.tif (15 arc-second topography + bathymetry)',
  width: x1 - x0,
  height: y1 - y0,
  lonMin: ox + x0 * rx, // west edge of the first column
  latMax: oy + y0 * ry, // north edge of the first row
  dLon: rx,
  dLat: -ry,
  nodata: Number(image.getGDALNoData()),
};
fs.writeFileSync(path.join(outDir, 'sanriku_15s.json'), JSON.stringify(meta, null, 2));
console.log(`bathy grid ${meta.width}x${meta.height} -> ${outDir}`);
