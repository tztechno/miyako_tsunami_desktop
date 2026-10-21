import { fromFile } from 'geotiff';

/**
 * Seabed sampler from japan.tif (15 arc-second topography + bathymetry, WGS84, int16 m).
 * The raster is far coarser (~360 x 460 m) than the 5 m regions, so pixels that touch the
 * coast hold land heights. Only negative (sea) pixels are trusted; land pixels are filled
 * from neighbouring sea pixels so that bays narrower than a pixel still get a seabed.
 * Returns depthAt(lon, lat) -> elevation (m, negative) by bilinear interpolation.
 */
export async function loadBathymetry(tifPath, { lonMin, lonMax, latMin, latMax, pad = 8 }) {
  const tiff = await fromFile(tifPath);
  const image = await tiff.getImage();
  const [ox, oy] = image.getOrigin();
  const [rx, ry] = image.getResolution();
  const nodata = Number(image.getGDALNoData());

  const x0 = Math.max(0, Math.floor((lonMin - ox) / rx) - pad);
  const x1 = Math.min(image.getWidth(), Math.ceil((lonMax - ox) / rx) + pad);
  const y0 = Math.max(0, Math.floor((latMax - oy) / ry) - pad);
  const y1 = Math.min(image.getHeight(), Math.ceil((latMin - oy) / ry) + pad);
  const w = x1 - x0, h = y1 - y0;
  const [raw] = await image.readRasters({ window: [x0, y0, x1, y1] });

  const z = new Float32Array(w * h);
  let valid = new Uint8Array(w * h);
  let nSea = 0;
  for (let k = 0; k < w * h; k++) {
    const v = raw[k];
    if (v !== nodata && v < 0) { z[k] = v; valid[k] = 1; nSea++; }
  }
  if (nSea === 0) throw new Error(`japan.tif has no sea pixels in window [${x0},${y0},${x1},${y1}]`);

  // Fill land pixels outward from the sea (mean of valid 8-neighbours, one ring per pass)
  for (let remaining = w * h - nSea; remaining > 0;) {
    const next = valid.slice();
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (valid[k]) continue;
        let s = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= w || jj >= h || !valid[jj * w + ii]) continue;
            s += z[jj * w + ii];
            n++;
          }
        }
        if (n) { z[k] = s / n; next[k] = 1; remaining--; }
      }
    }
    valid = next;
  }

  const depthAt = (lon, lat) => {
    const fx = Math.min(w - 1.001, Math.max(0, (lon - ox) / rx - x0 - 0.5));
    const fy = Math.min(h - 1.001, Math.max(0, (lat - oy) / ry - y0 - 0.5));
    const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
    const a = z[j * w + i], b = z[j * w + i + 1], c = z[(j + 1) * w + i], d = z[(j + 1) * w + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
  return { depthAt, window: [x0, y0, x1, y1], seaPixels: nSea };
}
