// Builds a 2 m detail tile inside the app from on-line sources (same pipeline as N65 nagoya_flood):
//   terrain   GSI DEM5A elevation tiles (5 m) bilinear onto the 2 m grid, corrected with PLATEAU building bases
//   water     DEM5A NoData (sea, rivers, canals) connected to the water of the 5 m region grid; the seabed
//             and river beds come from the 5 m grid (japan.tif bathymetry tapered at the quays)
//   buildings PLATEAU CityGML LOD1 solids per 3rd-level mesh via the PLATEAU data catalog API (not thinned)
//   photos    GSI seamless aerial photo tiles
import { toPlane, toLonLat } from '../proj.js';

const CATALOG = 'https://api.plateauview.mlit.go.jp/datacatalog/citygml/';
const GSI = 'https://cyberjapandata.gsi.go.jp/xyz';
export const TILE_MARGIN_M = 120; // the tile stays this far inside the 5 m grid, which feeds its edges

// ---------------------------------------------------------------- small helpers
const lonLatToTile = (lon, lat, z) => {
  const n = 2 ** z, r = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n];
};
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const k = next++; await fn(items[k], k); } }));
}
async function fetchOk(url, kind = 'text') {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return kind === 'text' ? r.text() : kind === 'json' ? r.json() : r.blob();
    } catch (e) {
      if (attempt >= 2) throw new Error(`${url}: ${e.message}`);
      await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
    }
  }
}
/** Image → RGBA pixels without colour conversion (exact values for the DEM PNGs). */
async function pixels(blob) {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  return { w: bmp.width, h: bmp.height, data: g.getImageData(0, 0, bmp.width, bmp.height).data };
}
const parseNums = (s) => { const p = s.trim().split(/\s+/); const a = new Float64Array(p.length); for (let i = 0; i < p.length; i++) a[i] = +p[i]; return a; };
const posLists = (t) => [...t.matchAll(/<gml:posList[^>]*>([^<]+)<\/gml:posList>/g)].map((m) => parseNums(m[1]));
function blocks(text, open, close, fn) {
  let pos = 0;
  for (;;) {
    const a = text.indexOf(open, pos);
    if (a < 0) return;
    const b = text.indexOf(close, a + open.length);
    if (b < 0) return;
    fn(text.substring(a + open.length, b));
    pos = b + close.length;
  }
}
/** Japanese standard mesh codes (3rd level, ~1 km) covering a lat/lon box. */
function meshCodes(box) {
  const out = [];
  for (let lat = Math.floor(box.latMin * 120) / 120; lat < box.latMax; lat += 1 / 120) {
    for (let lon = Math.floor(box.lonMin * 80) / 80; lon < box.lonMax; lon += 1 / 80) {
      const la = lat + 1e-7, lo = lon + 1e-7;
      const p = Math.floor(la * 1.5), u = Math.floor(lo - 100);
      const q = Math.floor((la * 1.5 - p) * 8), v = Math.floor((lo - 100 - u) * 8);
      const r = Math.floor(((la * 1.5 - p) * 8 - q) * 10), w = Math.floor(((lo - 100 - u) * 8 - v) * 10);
      out.push(`${p}${u}${q}${v}${r}${w}`);
    }
  }
  return [...new Set(out)];
}
/** Aerial JPEG over [originE .. originE+W] x [originN-H .. originN] resampled onto the EPSG:6674 grid. */
async function aerial({ originE, originN, widthM, heightM, zoom, metersPerPx, maxPx = 4096, onTile }) {
  const scale = Math.max(metersPerPx, Math.max(widthM, heightM) / maxPx);
  const W = Math.round(widthM / scale), H = Math.round(heightM / scale);
  const step = 16, lw = Math.ceil(W / step) + 1, lh = Math.ceil(H / step) + 1;
  const lat = new Float64Array(lw * lh * 2);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let j = 0; j < lh; j++) for (let i = 0; i < lw; i++) {
    const [lo, la] = toLonLat(originE + Math.min(i * step, W) * scale, originN - Math.min(j * step, H) * scale);
    const [tx, ty] = lonLatToTile(lo, la, zoom);
    lat[(j * lw + i) * 2] = tx; lat[(j * lw + i) * 2 + 1] = ty;
    x0 = Math.min(x0, tx); x1 = Math.max(x1, tx); y0 = Math.min(y0, ty); y1 = Math.max(y1, ty);
  }
  const tiles = new Map(), jobs = [];
  for (let y = Math.floor(y0); y <= Math.floor(y1); y++) for (let x = Math.floor(x0); x <= Math.floor(x1); x++) jobs.push([x, y]);
  let done = 0;
  await pool(jobs, 8, async ([x, y]) => {
    const b = await fetchOk(`${GSI}/seamlessphoto/${zoom}/${x}/${y}.jpg`, 'blob');
    tiles.set(`${x}_${y}`, b ? await pixels(b) : null);
    onTile?.(++done, jobs.length);
  });
  const out = new OffscreenCanvas(W, H), g = out.getContext('2d');
  const img = g.createImageData(W, H), d = img.data;
  for (let y = 0; y < H; y++) {
    const gj = y / step, j0 = Math.min(Math.floor(gj), lh - 2), fj = gj - j0;
    for (let x = 0; x < W; x++) {
      const gi = x / step, i0 = Math.min(Math.floor(gi), lw - 2), fi = gi - i0;
      const a = (j0 * lw + i0) * 2, b = a + 2, c = a + lw * 2, e = c + 2;
      const tx = (lat[a] * (1 - fi) + lat[b] * fi) * (1 - fj) + (lat[c] * (1 - fi) + lat[e] * fi) * fj;
      const ty = (lat[a + 1] * (1 - fi) + lat[b + 1] * fi) * (1 - fj) + (lat[c + 1] * (1 - fi) + lat[e + 1] * fi) * fj;
      const fx = Math.floor(tx), fy = Math.floor(ty), t = tiles.get(`${fx}_${fy}`), o = (y * W + x) * 4;
      if (!t) { d[o] = d[o + 1] = d[o + 2] = 128; d[o + 3] = 255; continue; }
      const px = Math.min(255, Math.floor((tx - fx) * 256)), py = Math.min(255, Math.floor((ty - fy) * 256)), s = (py * 256 + px) * 4;
      d[o] = t.data[s]; d[o + 1] = t.data[s + 1]; d[o + 2] = t.data[s + 2]; d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return { blob: await out.convertToBlob({ type: 'image/jpeg', quality: 0.85 }), width: W, height: H };
}

/**
 * Tile placement: a size x size square centred near (worldX, worldZ) (region-local metres), moved so it stays
 * TILE_MARGIN_M inside the 5 m grid. Returns { originE, originN, nx, ny, res } or null if it cannot fit.
 */
export function placeTile(region, worldX, worldZ, size, res = 2) {
  const half = size / 2, m = TILE_MARGIN_M;
  if (size + 2 * m > Math.min(region.widthM, region.heightM)) return null;
  const cx = Math.min(region.widthM - m - half, Math.max(m + half, worldX));
  const cz = Math.min(region.heightM - m - half, Math.max(m + half, worldZ));
  const originE = Math.round((region.originE + cx - half) / res) * res;
  const originN = Math.round((region.originN - (cz - half)) / res) * res;
  const nx = Math.round(size / res);
  return { originE, originN, nx, ny: nx, res };
}

// ---------------------------------------------------------------- the tile
/**
 * opts: { name, label, worldX, worldZ, size (m), res (m), region: { meta, ground, waterMask } }
 * progress(frac 0..1, ja, en). Returns { meta, files } ready for store.saveTile.
 */
export async function buildTile(opts, progress = () => {}) {
  const { name, size = 2000, res = 2, region } = opts;
  const R = region.meta;
  const place = placeTile(R, opts.worldX, opts.worldZ, size, res);
  if (!place) throw new Error('tile does not fit in the simulation area');
  const { originE, originN, nx, ny } = place, N = nx * ny;
  const corners = [toLonLat(originE, originN), toLonLat(originE + nx * res, originN), toLonLat(originE, originN - ny * res), toLonLat(originE + nx * res, originN - ny * res)];
  const m = 0.0005;
  const llBox = {
    lonMin: Math.min(...corners.map((c) => c[0])) - m, lonMax: Math.max(...corners.map((c) => c[0])) + m,
    latMin: Math.min(...corners.map((c) => c[1])) - m, latMax: Math.max(...corners.map((c) => c[1])) + m,
  };
  const yieldUI = () => new Promise((r) => setTimeout(r, 0));
  // 5 m grid cell under a tile cell
  const regionCell = (i, j) => {
    const ri = Math.floor((originE - R.originE + (i + 0.5) * res) / R.res), rj = Math.floor((R.originN - originN + (j + 0.5) * res) / R.res);
    return Math.min(R.ny - 1, Math.max(0, rj)) * R.nx + Math.min(R.nx - 1, Math.max(0, ri));
  };

  // ---- 1. terrain from GSI DEM5A (z15), bilinear onto the grid; NoData = sea / rivers / canals
  progress(0.02, '地形(5m標高)を取得中…', 'Fetching terrain (5 m DEM)…');
  const Z = 15;
  const [tx0, ty0] = lonLatToTile(llBox.lonMin, llBox.latMax, Z), [tx1, ty1] = lonLatToTile(llBox.lonMax, llBox.latMin, Z);
  const demTiles = new Map(), demJobs = [];
  for (let y = Math.floor(ty0); y <= Math.floor(ty1); y++) for (let x = Math.floor(tx0); x <= Math.floor(tx1); x++) demJobs.push([x, y]);
  await pool(demJobs, 8, async ([x, y]) => {
    const b = await fetchOk(`${GSI}/dem5a_png/${Z}/${x}/${y}.png`, 'blob');
    if (!b) return;
    const p = await pixels(b);
    const h = new Float32Array(256 * 256);
    for (let k = 0; k < h.length; k++) {
      const v = p.data[k * 4] * 65536 + p.data[k * 4 + 1] * 256 + p.data[k * 4 + 2];
      h[k] = v === 8388608 ? NaN : (v < 8388608 ? v : v - 16777216) * 0.01;
    }
    demTiles.set(`${x}_${y}`, h);
  });
  const demAt = (fx, fy) => { // fractional tile coords, sample at pixel centres; NaN when the nearest pixel is NoData
    const px = fx * 256 - 0.5, py = fy * 256 - 0.5;
    const ix = Math.floor(px), iy = Math.floor(py), tx = px - ix, ty = py - iy;
    const get = (X, Y) => { const t = demTiles.get(`${Math.floor(X / 256)}_${Math.floor(Y / 256)}`); return t ? t[(((Y % 256) + 256) % 256) * 256 + (((X % 256) + 256) % 256)] : NaN; };
    const a = get(ix, iy), b = get(ix + 1, iy), c = get(ix, iy + 1), d = get(ix + 1, iy + 1);
    const nearest = [a, b, c, d][(ty < 0.5 ? 0 : 2) + (tx < 0.5 ? 0 : 1)];
    if (Number.isNaN(nearest)) return NaN;
    if ([a, b, c, d].some(Number.isNaN)) { const v = [a, b, c, d].filter((q) => !Number.isNaN(q)); return v.reduce((s, q) => s + q, 0) / v.length; }
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
  const dem = new Float32Array(N);
  const nodata = new Uint8Array(N);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const [lo, la] = toLonLat(originE + (i + 0.5) * res, originN - (j + 0.5) * res);
      const [fx, fy] = lonLatToTile(lo, la, Z);
      const h = demAt(fx, fy);
      if (Number.isNaN(h)) nodata[j * nx + i] = 1;
      else dem[j * nx + i] = h;
    }
    if (j % 100 === 0) { progress(0.05 + 0.08 * (j / ny), '地形を格子にしています…', 'Gridding the terrain…'); await yieldUI(); }
  }

  // ---- 1b. water = NoData connected to the water of the 5 m grid (other NoData pools are ponds / roofs)
  const water = new Uint8Array(N);
  {
    const stack = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (nodata[k] && region.waterMask[regionCell(i, j)]) { water[k] = 1; stack.push(k); }
    }
    while (stack.length) {
      const k = stack.pop(), i = k % nx;
      for (const q of [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, k >= nx ? k - nx : -1, k < N - nx ? k + nx : -1]) {
        if (q >= 0 && nodata[q] && !water[q]) { water[q] = 1; stack.push(q); }
      }
    }
  }
  // ponds: height of the 5 m grid there; water: its bed from the 5 m grid (nearest water cell), at most -1 m
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    if (!nodata[k]) continue;
    const rk = regionCell(i, j);
    if (!water[k]) { dem[k] = region.ground[rk]; continue; }
    let bed = region.waterMask[rk] ? region.ground[rk] : NaN;
    for (let r = 1; Number.isNaN(bed) && r <= 3; r++) {
      const ri = rk % R.nx, rj = Math.floor(rk / R.nx);
      for (let dj = -r; dj <= r && Number.isNaN(bed); dj++) for (let di = -r; di <= r; di++) {
        const a = ri + di, b = rj + dj;
        if (a < 0 || b < 0 || a >= R.nx || b >= R.ny) continue;
        if (region.waterMask[b * R.nx + a]) { bed = region.ground[b * R.nx + a]; break; }
      }
    }
    dem[k] = Math.min(-1, Number.isNaN(bed) ? -3 : bed);
  }

  // ---- 2. PLATEAU buildings (per 3rd-level mesh)
  progress(0.14, 'PLATEAU の建物を取得中…', 'Fetching PLATEAU buildings…');
  const meshes = meshCodes(llBox);
  const bldgUrls = new Set();
  await pool(meshes, 6, async (code) => {
    const j = await fetchOk(CATALOG + 'm:' + code, 'json').catch(() => null);
    for (const c of j?.cities || []) for (const f of c.files?.bldg || []) bldgUrls.add(f.url);
  });
  const buildings = [];
  const W_M = nx * res, H_M = ny * res;
  const num = (re, s) => { const mm = re.exec(s); return mm ? +mm[1] : NaN; };
  const seen = new Set();
  let nb = 0;
  await pool([...bldgUrls], 4, async (url) => {
    const text = await fetchOk(url, 'text');
    if (text) {
      blocks(text, '<bldg:Building ', '</bldg:Building>', (blk) => {
        const id = (/gml:id="([^"]+)"/.exec(blk) || [])[1] || '';
        if (id && seen.has(id)) return; // a building on a city border is listed by both cities
        const measured = num(/<bldg:measuredHeight[^>]*>([^<]+)</, blk);
        for (const sm of blk.matchAll(/<bldg:lod1Solid>([\s\S]*?)<\/bldg:lod1Solid>/g)) {
          const lists = posLists(sm[1]);
          if (!lists.length) continue;
          let zMin = Infinity, zMax = -Infinity;
          for (const l of lists) for (let i = 2; i < l.length; i += 3) { zMin = Math.min(zMin, l[i]); zMax = Math.max(zMax, l[i]); }
          let bottom = null;
          for (const l of lists) {
            let flat = true;
            for (let i = 2; i < l.length; i += 3) if (Math.abs(l[i] - zMin) > 1e-3) { flat = false; break; }
            if (flat && (!bottom || l.length > bottom.length)) bottom = l;
          }
          if (!bottom || bottom.length < 12) continue;
          const ring = [];
          let inside = false;
          for (let i = 0; i < bottom.length / 3 - 1; i++) {
            const [e, n] = toPlane(bottom[i * 3 + 1], bottom[i * 3]);
            const x = e - originE, z = originN - n;
            if (x >= 0 && x <= W_M && z >= 0 && z <= H_M) inside = true;
            ring.push(x, z);
          }
          if (inside) { buildings.push({ id, base: zMin, top: zMax, measured, ring }); if (id) seen.add(id); }
        }
      });
    }
    progress(0.14 + 0.36 * (++nb / Math.max(1, bldgUrls.size)), `建物を読み込み中… ${buildings.length.toLocaleString()} 棟`, `Reading buildings… ${buildings.length.toLocaleString()}`);
  });

  // footprints -> building grid (cells whose centre is on the footprint; not on the water: bridges, piers)
  const bldgGrid = new Int32Array(N).fill(-1), cellCount = new Int32Array(buildings.length);
  buildings.forEach((b, bi) => {
    const r = b.ring, n = r.length / 2;
    let zmin = Infinity, zmax = -Infinity;
    for (let i = 0; i < n; i++) { zmin = Math.min(zmin, r[i * 2 + 1]); zmax = Math.max(zmax, r[i * 2 + 1]); }
    for (let j = Math.max(0, Math.ceil(zmin / res - 0.5)); j <= Math.min(ny - 1, Math.floor(zmax / res - 0.5)); j++) {
      const zc = (j + 0.5) * res, xs = [];
      for (let i = 0, k = n - 1; i < n; k = i++) {
        const z1 = r[k * 2 + 1], z2 = r[i * 2 + 1];
        if ((z1 <= zc && z2 > zc) || (z2 <= zc && z1 > zc)) xs.push(r[k * 2] + ((zc - z1) / (z2 - z1)) * (r[i * 2] - r[k * 2]));
      }
      xs.sort((a, c) => a - c);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        for (let i = Math.max(0, Math.ceil(xs[q] / res - 0.5)); i <= Math.min(nx - 1, Math.floor(xs[q + 1] / res - 0.5)); i++) {
          const k = j * nx + i;
          if (water[k]) continue;
          bldgGrid[k] = bi; cellCount[bi]++;
        }
      }
    }
    if (!cellCount[bi]) {
      let cx = 0, cz = 0;
      for (let i = 0; i < n; i++) { cx += r[i * 2]; cz += r[i * 2 + 1]; }
      const i = Math.floor(cx / n / res), j = Math.floor(cz / n / res);
      if (i >= 0 && i < nx && j >= 0 && j < ny && bldgGrid[j * nx + i] < 0 && !water[j * nx + i]) { bldgGrid[j * nx + i] = bi; cellCount[bi]++; }
    }
  });
  progress(0.52, '建物の隙間を処理中…', 'Closing gaps between buildings…');
  await yieldUI();
  { // small gaps enclosed by buildings (< 120 m²) join the neighbouring building
    const minCells = Math.max(4, Math.round(120 / (res * res)));
    const comp = new Int32Array(N).fill(-1), stack = new Int32Array(N);
    let id = 0;
    for (let s = 0; s < N; s++) {
      if (bldgGrid[s] >= 0 || comp[s] >= 0 || water[s]) continue;
      let sp = 0, sz = 0, edge = false;
      const cells = [], votes = new Map();
      stack[sp++] = s; comp[s] = id;
      while (sp) {
        const k = stack[--sp];
        sz++;
        if (sz <= minCells) cells.push(k);
        const i = k % nx, j = (k / nx) | 0;
        if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) edge = true;
        for (const q of [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1]) {
          if (q < 0) continue;
          const b = bldgGrid[q];
          if (b >= 0) votes.set(b, (votes.get(b) || 0) + 1);
          else if (water[q]) edge = true; // open to the water: a quay, not a courtyard
          else if (comp[q] < 0) { comp[q] = id; stack[sp++] = q; }
        }
      }
      id++;
      if (!edge && sz <= minCells && votes.size) {
        let best = -1, bv = -1;
        for (const [b, v] of votes) if (v > bv) { best = b; bv = v; }
        for (const k of cells) { bldgGrid[k] = best; cellCount[best]++; }
      }
    }
  }

  // ---- 3. ground correction with the building base elevations (land only)
  const demSum = new Float64Array(buildings.length);
  for (let k = 0; k < N; k++) if (bldgGrid[k] >= 0) demSum[bldgGrid[k]] += dem[k];
  const resid = new Float64Array(buildings.length).fill(NaN);
  buildings.forEach((b, bi) => { if (cellCount[bi]) resid[bi] = b.base - demSum[bi] / cellCount[bi]; });
  const S = new Float32Array(N), Wt = new Float32Array(N);
  for (let k = 0; k < N; k++) { const bi = bldgGrid[k]; if (bi >= 0 && Math.abs(resid[bi]) <= 3) { S[k] = resid[bi]; Wt[k] = 1; } }
  const boxBlur = (a, r) => {
    const tmp = new Float32Array(N);
    for (let pass = 0; pass < 3; pass++) {
      for (let j = 0; j < ny; j++) { let acc = 0; const row = j * nx; for (let i = -r; i <= r; i++) acc += a[row + Math.min(nx - 1, Math.max(0, i))]; for (let i = 0; i < nx; i++) { tmp[row + i] = acc / (2 * r + 1); acc += a[row + Math.min(nx - 1, i + r + 1)] - a[row + Math.max(0, i - r)]; } }
      for (let i = 0; i < nx; i++) { let acc = 0; for (let j = -r; j <= r; j++) acc += tmp[Math.min(ny - 1, Math.max(0, j)) * nx + i]; for (let j = 0; j < ny; j++) { a[j * nx + i] = acc / (2 * r + 1); acc += tmp[Math.min(ny - 1, j + r + 1) * nx + i] - tmp[Math.max(0, j - r) * nx + i]; } }
    }
  };
  const blurR = Math.max(1, Math.round(15 / res / 2));
  boxBlur(S, blurR); boxBlur(Wt, blurR);
  const ground = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const bi = bldgGrid[k];
    if (water[k]) ground[k] = dem[k];
    else ground[k] = bi >= 0 ? buildings[bi].base : Wt[k] > 1e-4 ? dem[k] + (S[k] / Wt[k]) * Math.min(1, Wt[k] / 0.05) : dem[k];
  }

  // ---- 4. aerial photos
  progress(0.6, '航空写真を取得中…', 'Fetching aerial photos…');
  const photo = await aerial({ originE, originN, widthM: nx * res, heightM: ny * res, zoom: 18, metersPerPx: 0.5,
    onTile: (i, n) => progress(0.6 + 0.37 * (i / n), `航空写真を取得中… ${i}/${n}`, `Fetching aerial photos… ${i}/${n}`) });

  // ---- 5. package
  progress(0.98, '保存中…', 'Saving…');
  const attr = new Float32Array(buildings.length * 3), vstart = new Uint32Array(buildings.length + 1);
  let nv = 0;
  buildings.forEach((b, i) => { vstart[i] = nv; nv += b.ring.length / 2; });
  vstart[buildings.length] = nv;
  const verts = new Float32Array(nv * 2);
  buildings.forEach((b, i) => { attr.set([b.base, b.top, b.measured], i * 3); verts.set(b.ring, vstart[i] * 2); });
  const [lon, lat] = toLonLat(originE + (nx * res) / 2, originN - (ny * res) / 2);
  const meta = {
    name, label: opts.label || name, nx, ny, res, crs: 'EPSG:6678', region: R.name, originE, originN, size: nx * res,
    center: { lat, lon }, buildings: buildings.length, demSource: 'GSI DEM5A', regionBuilt: R.built,
    aerial: { width: photo.width, height: photo.height }, built: new Date().toISOString(),
  };
  const files = {
    'ground.f32': ground.buffer, 'water.u8': water.buffer, 'bldg_grid.i32': bldgGrid.buffer,
    'bldg_attr.f32': attr.buffer, 'bldg_vstart.u32': vstart.buffer, 'bldg_verts.f32': verts.buffer,
    'aerial.jpg': photo.blob,
  };
  progress(1, '完了', 'Done');
  return { meta, files };
}
