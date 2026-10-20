// Depth distribution of the 5 m inundation mesh in a region (to spot outliers).
// usage: node tools/check-inund5.mjs [region]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(appRoot, 'public', 'data', 'regions', process.argv[2] || 'taro');
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const mb = fs.readFileSync(path.join(dir, 'inund2011_5m.bin'));
const a = new Uint16Array(mb.buffer, mb.byteOffset, mb.byteLength / 2);
const gb = fs.readFileSync(path.join(dir, 'ground.f32'));
const g = new Float32Array(gb.buffer, gb.byteOffset, gb.byteLength / 4);
const bins = [0, 0.3, 1, 3, 5, 10, 20, 30, 50, 100, 1000];
const counts = new Array(bins.length).fill(0);
const big = [];
for (let i = 0; i < a.length; i++) {
  if (a[i] === 65535 || a[i] === 65534) continue; // no data / flooded with unknown depth
  const d = a[i] / 100;
  let k = bins.length - 1;
  while (k > 0 && d < bins[k]) k--;
  counts[k]++;
  if (d > 30 && big.length < 8) big.push({ x: i % meta.nx, z: Math.floor(i / meta.nx), d, ground: +g[i].toFixed(1) });
}
bins.forEach((b, k) => console.log(`>= ${b}m: ${counts[k]}`));
console.log('examples > 30m:', big);
