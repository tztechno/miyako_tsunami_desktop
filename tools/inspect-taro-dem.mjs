import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return [x, y];
}

async function fetchTile(z, x, y) {
  const cacheFile = `.cache/${z}_${x}_${y}.png`;
  if (fs.existsSync(cacheFile)) {
    return PNG.sync.read(fs.readFileSync(cacheFile));
  }
  const url = `https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/${z}/${x}/${y}.png`;
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`Tile ${z}/${x}/${y} failed: ${res.status}`);
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync('.cache', { recursive: true });
  fs.writeFileSync(cacheFile, buf);
  return PNG.sync.read(buf);
}

function decodePngH(png, px, py) {
  const k = (py * 256 + px) * 4;
  const r = png.data[k], g = png.data[k + 1], b = png.data[k + 2];
  const v = r * 65536 + g * 256 + b;
  return v === 8388608 ? NaN : (v < 8388608 ? v : v - 16777216) * 0.01;
}

async function main() {
  const lat = 39.7368;
  const lon = 141.9720;
  const z = 15;
  const [fx, fy] = lonLatToTile(lon, lat, z);
  const tx = Math.floor(fx), ty = Math.floor(fy);
  console.log(`Taro Center tile z=${z}: x=${tx}, y=${ty}`);

  const png = await fetchTile(z, tx, ty);
  if (!png) return;

  // Let's sample along a line from sea to land (East to West at approx lat 39.7368)
  // Easting: 141.980 (sea) -> 141.965 (land)
  console.log('\n--- East-West Cross Section at lat ~39.7368 ---');
  for (let l = 141.982; l >= 141.962; l -= 0.001) {
    const [cx, cy] = lonLatToTile(l, lat, z);
    const px = Math.floor((cx - tx) * 256);
    const py = Math.floor((cy - ty) * 256);
    if (px >= 0 && px < 256 && py >= 0 && py < 256) {
      const h = decodePngH(png, px, py);
      console.log(`Lon ${l.toFixed(4)}: h = ${Number.isNaN(h) ? 'SEA' : h.toFixed(2) + 'm'}`);
    }
  }

  // Also inspect 3x3 tiles around Taro
  let validCount = 0, seaCount = 0;
  let minH = Infinity, maxH = -Infinity;
  const heights = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const p = await fetchTile(z, tx + dx, ty + dy);
      if (!p) continue;
      for (let y = 0; y < 256; y += 4) {
        for (let x = 0; x < 256; x += 4) {
          const h = decodePngH(p, x, y);
          if (Number.isNaN(h)) {
            seaCount++;
          } else {
            validCount++;
            if (h < minH) minH = h;
            if (h > maxH) maxH = h;
            if (h >= 8 && h <= 18) heights.push(h);
          }
        }
      }
    }
  }
  console.log(`\nSurrounding 3x3 tiles stats:`);
  console.log(`Sea samples: ${seaCount}, Land samples: ${validCount}`);
  console.log(`Land elevation range: ${minH.toFixed(2)}m to ${maxH.toFixed(2)}m`);
  console.log(`Samples between 8m and 18m (seawall & coastal plain range): ${heights.length}`);
}

main().catch(console.error);
