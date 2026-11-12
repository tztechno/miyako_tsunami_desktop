// A stored 2 m detail tile in memory: grids, buildings, the seawalls / levees / gates of the active era on the
// 2 m grid, and the street cells around each building (for the flood depth at a building).

/** record: { meta, files } from store.getTile. region: the 5 m grid's meta (tile offset in it). */
export function loadTile(record, regionMeta) {
  const { meta, files } = record;
  const { nx, ny, res } = meta;
  const N = nx * ny;
  const ground = new Float32Array(files['ground.f32']);
  const water = new Uint8Array(files['water.u8']);
  const bldgGrid = new Int32Array(files['bldg_grid.i32']);
  const attr = new Float32Array(files['bldg_attr.f32']);
  const vstart = new Uint32Array(files['bldg_vstart.u32']);
  const verts = new Float32Array(files['bldg_verts.f32']);
  const count = vstart.length - 1;

  // Street cells touching each building (CSR lists)
  const perimStart = new Uint32Array(count + 1);
  const touch = (k, fn) => {
    const i = k % nx, j = (k / nx) | 0, b = bldgGrid[k];
    for (const q of [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1]) {
      if (q >= 0 && bldgGrid[q] < 0 && !water[q]) fn(b, q);
    }
  };
  for (let k = 0; k < N; k++) if (bldgGrid[k] >= 0) touch(k, (b) => perimStart[b + 1]++);
  for (let b = 0; b < count; b++) perimStart[b + 1] += perimStart[b];
  const perim = new Uint32Array(perimStart[count]);
  const fill = perimStart.slice();
  for (let k = 0; k < N; k++) if (bldgGrid[k] >= 0) touch(k, (b, q) => (perim[fill[b]++] = q));

  return {
    meta, nx, ny, res, N, ground, water, bldgGrid,
    buildings: { count, attr, vstart, verts, base: (i) => attr[i * 3], top: (i) => attr[i * 3 + 1] },
    perimStart, perim,
    aerialBlob: files['aerial.jpg'],
    // tile origin in the 5 m grid's local metres (x east, z south)
    offX: meta.originE - regionMeta.originE,
    offZ: regionMeta.originN - meta.originN,
    widthM: nx * res,
    heightM: ny * res,
  };
}

/**
 * Surface the flow runs on: ground, buildings as solid blocks up to their roofs, and the seawalls, levees and
 * gates of the active era (src/seawall.js, same lines and crest heights as the 5 m run).
 * Returns { dsm, wall, wallKind } (wall: crest height on wall / gate cells, NaN elsewhere; wallKind 1 seawall,
 * 2 river levee, 3 gate — for drawing).
 */
export function tileSurface(tile, seawallMgr, regionMeta) {
  const { nx, ny, res, N, ground, bldgGrid, buildings } = tile;
  const dsm = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const b = bldgGrid[k];
    dsm[k] = b >= 0 ? ground[k] + Math.max(3, buildings.top(b) - buildings.base(b)) : ground[k];
  }
  const wall = new Float32Array(N).fill(NaN);
  const wallKind = new Uint8Array(N);
  const raise = (k, h, kind) => {
    if (h > dsm[k]) { dsm[k] = h; wall[k] = h; wallKind[k] = kind; }
  };
  // cells within half the wall's width of its line, and at least a cell either side (no gaps on the 2 m grid)
  for (const sw of seawallMgr.getActiveSeawallList()) {
    const h = sw.defaultHeight;
    const kind = sw.type === 'gate' ? 3 : sw.type === 'levee' ? 2 : 1;
    const halfW = (sw.width || 2) / 2 + res;
    const pts = sw.points.map((p) => [p.e - regionMeta.originE - tile.offX, regionMeta.originN - p.n - tile.offZ]);
    for (let s = 0; s + 1 < pts.length; s++) {
      const [x0, z0] = pts[s], [x1, z1] = pts[s + 1];
      const dx = x1 - x0, dz = z1 - z0, l2 = dx * dx + dz * dz || 1;
      const i0 = Math.max(0, Math.floor((Math.min(x0, x1) - halfW) / res)), i1 = Math.min(nx - 1, Math.ceil((Math.max(x0, x1) + halfW) / res));
      const j0 = Math.max(0, Math.floor((Math.min(z0, z1) - halfW) / res)), j1 = Math.min(ny - 1, Math.ceil((Math.max(z0, z1) + halfW) / res));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const cx = (i + 0.5) * res, cz = (j + 0.5) * res;
        const q = Math.max(0, Math.min(1, ((cx - x0) * dx + (cz - z0) * dz) / l2));
        if (Math.hypot(cx - (x0 + q * dx), cz - (z0 + q * dz)) <= halfW) raise(j * nx + i, h, kind);
      }
    }
  }
  return { dsm, wall, wallKind };
}

/**
 * Flood depth at each building = 90th percentile of the water depth on the street cells around it
 * (robust against a single deep cell at one corner; the same rule as nagoya_flood).
 */
export function buildingFloodDepth(tile, depth, out) {
  const { perimStart, perim } = tile;
  const buf = new Float32Array(8192);
  for (let b = 0; b < tile.buildings.count; b++) {
    const s = perimStart[b], n = Math.min(8192, perimStart[b + 1] - s);
    if (!n) { out[b] = 0; continue; }
    let wet = 0;
    for (let p = 0; p < n; p++) { buf[p] = depth[perim[s + p]]; if (buf[p] > 0.01) wet++; }
    if (!wet) { out[b] = 0; continue; }
    const v = buf.subarray(0, n).sort();
    out[b] = v[Math.min(n - 1, Math.floor(n * 0.9))];
  }
  return out;
}

/** Figures at one moment: flooded land (depth > 0.1 m, outside buildings and the water), buildings >= 0.5 m. */
export function tileStats(tile, depth, bFlood) {
  let wet = 0, hmax = 0;
  for (let k = 0; k < tile.N; k++) {
    if (tile.water[k] || tile.bldgGrid[k] >= 0) continue;
    const d = depth[k];
    if (d > 0.1) wet++;
    if (d > hmax) hmax = d;
  }
  let b05 = 0;
  for (let b = 0; b < bFlood.length; b++) if (bFlood[b] >= 0.5) b05++;
  return { areaHa: (wet * tile.res * tile.res) / 1e4, hmax, b05 };
}
