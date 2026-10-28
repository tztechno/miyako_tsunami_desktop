// Depth at a lon/lat off Sanriku from the japan.tif 15 arc-second grid (tools/build-bathy-grid.mjs),
// used for the depth at a wave CSV point.

let gridPromise = null;

function loadGrid() {
  if (!gridPromise) {
    gridPromise = (async () => {
      const meta = await (await fetch('data/bathy/sanriku_15s.json')).json();
      const z = new Int16Array(await (await fetch('data/bathy/sanriku_15s.bin')).arrayBuffer());
      return { meta, z };
    })().catch((e) => {
      console.warn('Bathymetry grid load failed:', e);
      gridPromise = null;
      return null;
    });
  }
  return gridPromise;
}

/** Water depth (m, positive) at lon/lat, bilinear over the surrounding sea pixels; null on land or outside the grid. */
export async function seaDepthAt(lon, lat) {
  const g = await loadGrid();
  if (!g || lon == null || lat == null) return null;
  const { width, height, lonMin, latMax, dLon, dLat, nodata } = g.meta;
  const fx = (lon - lonMin) / dLon - 0.5;
  const fy = (latMax - lat) / dLat - 0.5;
  const i = Math.floor(fx), j = Math.floor(fy);
  if (i < 0 || j < 0 || i >= width - 1 || j >= height - 1) return null;
  const tx = fx - i, ty = fy - j;
  let sum = 0, wsum = 0;
  for (const [di, dj, w] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
    const v = g.z[(j + dj) * width + i + di];
    if (v === nodata || v >= 0) continue;
    sum += -v * w;
    wsum += w;
  }
  return wsum > 0 ? sum / wsum : null;
}
