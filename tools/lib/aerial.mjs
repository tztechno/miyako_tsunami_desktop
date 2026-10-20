import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { toLonLat } from './proj.mjs';

const TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg';

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return [x, y];
}

async function fetchTile(cacheDir, z, x, y, tileUrl = TILE_URL, cacheTag = '') {
  const ext = tileUrl.endsWith('.png') ? 'png' : 'jpg';
  const file = path.join(cacheDir, `${cacheTag}${z}_${x}_${y}.${ext}`);
  if (!fs.existsSync(file)) {
    const url = tileUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
          break;
        }
        if (res.status === 404) return null;
      } catch (e) {
        if (attempt === 2) return null;
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  if (!fs.existsSync(file)) return null;
  try {
    const buf = fs.readFileSync(file);
    return ext === 'png' ? PNG.sync.read(buf) : jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  } catch {
    return null;
  }
}

/**
 * Resample XYZ tiles onto the region grid. `transparent: true` writes an RGBA PNG
 * (missing tiles / transparent tile pixels stay transparent) — used for hazard overlays.
 */
export async function buildAerial({
  outFile, cacheDir, originE, originN, widthM, heightM, zoom = 16, maxPx = 2048, metersPerPx = 2,
  tileUrl = TILE_URL, cacheTag = '', transparent = false,
}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const scale = Math.max(metersPerPx, Math.max(widthM, heightM) / maxPx);
  const W = Math.round(widthM / scale);
  const H = Math.round(heightM / scale);

  const step = 16;
  const lw = Math.ceil(W / step) + 1;
  const lh = Math.ceil(H / step) + 1;
  const lat = new Float64Array(lw * lh * 2);
  let txMin = Infinity, txMax = -Infinity, tyMin = Infinity, tyMax = -Infinity;
  for (let j = 0; j < lh; j++) {
    for (let i = 0; i < lw; i++) {
      const e = originE + Math.min(i * step, W) * scale;
      const n = originN - Math.min(j * step, H) * scale;
      const [lon, la] = toLonLat(e, n);
      const [tx, ty] = lonLatToTile(lon, la, zoom);
      lat[(j * lw + i) * 2] = tx;
      lat[(j * lw + i) * 2 + 1] = ty;
      txMin = Math.min(txMin, tx); txMax = Math.max(txMax, tx);
      tyMin = Math.min(tyMin, ty); tyMax = Math.max(tyMax, ty);
    }
  }
  const x0 = Math.floor(txMin), x1 = Math.floor(txMax), y0 = Math.floor(tyMin), y1 = Math.floor(tyMax);
  const tiles = new Map();
  const jobs = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) jobs.push([x, y]);
  console.log(`  aerial: ${jobs.length} tiles (z${zoom}) -> ${W}x${H}px`);
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < jobs.length) {
        const [x, y] = jobs[next++];
        tiles.set(`${x}_${y}`, await fetchTile(cacheDir, zoom, x, y, tileUrl, cacheTag));
      }
    })
  );

  const out = Buffer.alloc(W * H * 4);
  const sample = (tx, ty, o) => {
    const fx = Math.floor(tx), fy = Math.floor(ty);
    const t = tiles.get(`${fx}_${fy}`);
    if (!t) {
      if (transparent) { out[o + 3] = 0; return; }
      // Deep sea fallback color
      out[o] = 20; out[o + 1] = 45; out[o + 2] = 75; out[o + 3] = 255;
      return;
    }
    const px = Math.min(255, Math.max(0, Math.floor((tx - fx) * 256)));
    const py = Math.min(255, Math.max(0, Math.floor((ty - fy) * 256)));
    const s = (py * 256 + px) * 4;
    out[o] = t.data[s]; out[o + 1] = t.data[s + 1]; out[o + 2] = t.data[s + 2];
    out[o + 3] = transparent ? t.data[s + 3] : 255;
  };
  for (let y = 0; y < H; y++) {
    const gj = y / step, j0 = Math.min(Math.floor(gj), lh - 2), fj = gj - j0;
    for (let x = 0; x < W; x++) {
      const gi = x / step, i0 = Math.min(Math.floor(gi), lw - 2), fi = gi - i0;
      const a = (j0 * lw + i0) * 2, b = a + 2, c = a + lw * 2, d = c + 2;
      const tx = (lat[a] * (1 - fi) + lat[b] * fi) * (1 - fj) + (lat[c] * (1 - fi) + lat[d] * fi) * fj;
      const ty = (lat[a + 1] * (1 - fi) + lat[b + 1] * fi) * (1 - fj) + (lat[c + 1] * (1 - fi) + lat[d + 1] * fi) * fj;
      sample(tx, ty, (y * W + x) * 4);
    }
  }
  if (transparent) {
    const png = new PNG({ width: W, height: H });
    out.copy(png.data);
    fs.writeFileSync(outFile, PNG.sync.write(png));
  } else {
    fs.writeFileSync(outFile, jpeg.encode({ data: out, width: W, height: H }, 85).data);
  }
  return { width: W, height: H };
}
