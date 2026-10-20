import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { toLonLat } from './proj.mjs';

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return [x, y];
}

async function fetchDemTile(cacheDir, z, x, y) {
  const file = path.join(cacheDir, `${z}_${x}_${y}.png`);
  if (!fs.existsSync(file)) {
    // Try DEM5A first, then DEM10B
    const urls = [
      `https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/${z}/${x}/${y}.png`,
      `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${x}/${y}.png`,
    ];
    let ok = false;
    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
          ok = true;
          break;
        }
      } catch (e) {}
    }
    if (!ok) return null;
  }
  if (!fs.existsSync(file)) return null;
  try {
    const png = PNG.sync.read(fs.readFileSync(file));
    const h = new Float32Array(256 * 256);
    for (let k = 0; k < h.length; k++) {
      const r = png.data[k * 4], g = png.data[k * 4 + 1], b = png.data[k * 4 + 2];
      const v = r * 65536 + g * 256 + b;
      h[k] = v === 8388608 ? NaN : (v < 8388608 ? v : v - 16777216) * 0.01;
    }
    return h;
  } catch {
    return null;
  }
}

/**
 * Build elevation grid covering [originE, originE + nx*res] x [originN - ny*res, originN]
 * Sea cells (NaN from GSI) are assigned realistic coastal seabed bathymetry (negative elevation).
 */
export async function buildDem({ cacheDir, originE, originN, nx, ny, res, zoom = 15, seaFloorDepth = -15 }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const W_M = nx * res, H_M = ny * res;
  const corners = [
    toLonLat(originE, originN),
    toLonLat(originE + W_M, originN),
    toLonLat(originE, originN - H_M),
    toLonLat(originE + W_M, originN - H_M),
  ];
  const margin = 0.002;
  const lonMin = Math.min(...corners.map(c => c[0])) - margin;
  const lonMax = Math.max(...corners.map(c => c[0])) + margin;
  const latMin = Math.min(...corners.map(c => c[1])) - margin;
  const latMax = Math.max(...corners.map(c => c[1])) + margin;

  const [tx0, ty0] = lonLatToTile(lonMin, latMax, zoom);
  const [tx1, ty1] = lonLatToTile(lonMax, latMin, zoom);
  const x0 = Math.floor(tx0), x1 = Math.floor(tx1), y0 = Math.floor(ty0), y1 = Math.floor(ty1);

  const demTiles = new Map();
  const jobs = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) jobs.push([x, y]);
  console.log(`  DEM: ${jobs.length} tiles (z${zoom}) -> ${nx}x${ny} grid @ ${res}m`);

  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < jobs.length) {
        const [x, y] = jobs[next++];
        demTiles.set(`${x}_${y}`, await fetchDemTile(cacheDir, zoom, x, y));
      }
    })
  );

  const demAt = (fx, fy) => {
    const px = fx * 256 - 0.5, py = fy * 256 - 0.5;
    const ix = Math.floor(px), iy = Math.floor(py), tx = px - ix, ty = py - iy;
    const get = (X, Y) => {
      const t = demTiles.get(`${Math.floor(X / 256)}_${Math.floor(Y / 256)}`);
      return t ? t[(((Y % 256) + 256) % 256) * 256 + (((X % 256) + 256) % 256)] : NaN;
    };
    const a = get(ix, iy), b = get(ix + 1, iy), c = get(ix, iy + 1), d = get(ix + 1, iy + 1);
    const valid = [a, b, c, d].filter(v => !Number.isNaN(v));
    if (valid.length === 0) return NaN;
    if (valid.length < 4) return valid.reduce((s, v) => s + v, 0) / valid.length;
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };

  const dem = new Float32Array(nx * ny);
  const isSea = new Uint8Array(nx * ny);
  let minH = Infinity, maxH = -Infinity;

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const [lo, la] = toLonLat(originE + (i + 0.5) * res, originN - (j + 0.5) * res);
      const [fx, fy] = lonLatToTile(lo, la, zoom);
      const h = demAt(fx, fy);
      const idx = j * nx + i;
      if (Number.isNaN(h)) {
        isSea[idx] = 1;
        dem[idx] = NaN;
      } else {
        isSea[idx] = 0;
        dem[idx] = h;
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
  }

  // Seabed bathymetry: Compute distance to nearest land for sea cells to produce a smooth coastal bathymetry slope
  // (e.g. from 0m at coast deepening to seaFloorDepth m offshore)
  const dist = new Float32Array(nx * ny);
  dist.fill(1e9);
  // Multi-pass distance transform approximation
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i;
      if (!isSea[idx]) {
        dist[idx] = 0;
      } else {
        let d = 1e9;
        if (i > 0) d = Math.min(d, dist[idx - 1] + 1);
        if (j > 0) d = Math.min(d, dist[idx - nx] + 1);
        if (i > 0 && j > 0) d = Math.min(d, dist[idx - nx - 1] + 1.414);
        if (i < nx - 1 && j > 0) d = Math.min(d, dist[idx - nx + 1] + 1.414);
        dist[idx] = d;
      }
    }
  }
  for (let j = ny - 1; j >= 0; j--) {
    for (let i = nx - 1; i >= 0; i--) {
      const idx = j * nx + i;
      if (isSea[idx]) {
        let d = dist[idx];
        if (i < nx - 1) d = Math.min(d, dist[idx + 1] + 1);
        if (j < ny - 1) d = Math.min(d, dist[idx + nx] + 1);
        if (i < nx - 1 && j < ny - 1) d = Math.min(d, dist[idx + nx + 1] + 1.414);
        if (i > 0 && j < ny - 1) d = Math.min(d, dist[idx + nx - 1] + 1.414);
        dist[idx] = d;
      }
    }
  }

  for (let k = 0; k < dem.length; k++) {
    if (isSea[k]) {
      const distM = dist[k] * res;
      // Gradual slope down to seaFloorDepth (e.g. -15m to -35m)
      const depth = Math.max(seaFloorDepth, -1.0 - (distM / 300) * Math.abs(seaFloorDepth));
      dem[k] = depth;
      if (depth < minH) minH = depth;
    }
  }

  console.log(`  DEM built: elevation range [${minH.toFixed(1)}m, ${maxH.toFixed(1)}m]`);
  return { dem, isSea, minH, maxH };
}
