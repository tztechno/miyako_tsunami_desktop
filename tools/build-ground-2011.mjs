// Terrain at the time of the 2011 tsunami for the 当時 (pre-reconstruction) option.
// ground.f32 (DEM5A) was surveyed while the new Taro seawall was being built, so it holds its embankments.
// The 標高 column of the 復興支援調査 5 m inundation mesh (made in 2012, before those works; the 5 m squares
// coincide with the simulation grid cells) replaces the land inside the 2011 inundation area; outside it nothing
// changed in ways that matter to the flow, and the sea stays as it is.
//
// usage: node tools/build-ground-2011.mjs ../DOCS/fukkou/mesh5.shp [region]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [shpPath, region = 'taro'] = process.argv.slice(2);
if (!shpPath) throw new Error('usage: node tools/build-ground-2011.mjs path/to/mesh5.shp [region]');

/** Read one numeric DBF column (ASCII) for every record. */
function readDbfNumber(file, fieldName) {
  const b = fs.readFileSync(file);
  const nrec = b.readUInt32LE(4);
  const hlen = b.readUInt16LE(8);
  const rlen = b.readUInt16LE(10);
  const dec = new TextDecoder('shift_jis');
  let off = 1;
  let field = null;
  for (let p = 32; b[p] !== 0x0d; p += 32) {
    const name = dec.decode(b.subarray(p, p + 11)).replace(/\0.*$/, '');
    const len = b[p + 16];
    if (name === fieldName) field = { off, len };
    off += len;
  }
  if (!field) throw new Error(`field not found: ${fieldName}`);
  const out = new Float32Array(nrec);
  for (let r = 0; r < nrec; r++) {
    const s = hlen + r * rlen + field.off;
    out[r] = parseFloat(b.toString('latin1', s, s + field.len));
  }
  return out;
}

/** Lower-left corner (min x, min y) of each polygon record. */
function readShpCorners(file) {
  const b = fs.readFileSync(file);
  const xs = [];
  const ys = [];
  for (let p = 100; p < b.length; ) {
    const len = b.readInt32BE(p + 4) * 2;
    xs.push(b.readDoubleLE(p + 12));
    ys.push(b.readDoubleLE(p + 20));
    p += 8 + len;
  }
  return { xs, ys };
}

const dir = path.join(appRoot, 'public', 'data', 'regions', region);
const metaFile = path.join(dir, 'meta.json');
const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
const { nx, ny, res, originE, originN } = meta;
const buf = fs.readFileSync(path.join(dir, 'ground.f32'));
const ground = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

const { xs, ys } = readShpCorners(shpPath);
const elev = readDbfNumber(shpPath.replace(/\.shp$/i, '.dbf'), '標高');
const diffs = [];
let replaced = 0, skipped = 0;
for (let k = 0; k < xs.length; k++) {
  const gx = Math.round((xs[k] - originE) / res);
  const gz = Math.round((originN - (ys[k] + res)) / res);
  if (gx < 0 || gz < 0 || gx >= nx || gz >= ny) continue;
  const h = elev[k];
  const i = gz * nx + gx;
  if (!Number.isFinite(h) || h < -20 || h > 500 || ground[i] < 0) {
    skipped++;
    continue;
  }
  diffs.push(h - ground[i]);
  ground[i] = Math.max(0, h); // stays land: the sim treats ground < 0 as sea
  replaced++;
}
fs.writeFileSync(path.join(dir, 'ground_2011.f32'), Buffer.from(ground.buffer));

meta.ground2011 = { file: 'ground_2011.f32', source: '復興支援調査 5m mesh 標高 (2012, land in the 2011 inundation area) + GSI DEM5A + japan.tif', built: new Date().toISOString() };
fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));

diffs.sort((a, b) => a - b);
const q = (f) => diffs[Math.floor(diffs.length * f)]?.toFixed(2);
console.log(`${region}: replaced ${replaced} land cells, skipped ${skipped} (no value or sea)`);
console.log(`mesh - DEM5A (m): p1 ${q(0.01)} p10 ${q(0.1)} median ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)}`);
