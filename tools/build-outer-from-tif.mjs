import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromFile } from 'geotiff';
import { toPlane, toLonLat } from './lib/proj.mjs';
import { buildAerial } from './lib/aerial.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tifPath = path.resolve(appRoot, '..', 'miyako.tif');
const cacheDir = path.join(appRoot, '.cache', 'gsi');
const outDir = path.join(appRoot, 'public', 'data', 'regions', 'outer');

// Dimensions in EPSG:6678 plane coordinates
// Miyako area: approx 32km (E-W) x 26km (N-S)
const RES = 60; // 60m grid resolution for backdrop

async function main() {
  if (!fs.existsSync(tifPath)) {
    console.error('miyako.tif not found at', tifPath);
    process.exit(1);
  }

  const tiff = await fromFile(tifPath);
  const image = await tiff.getImage();
  const [ox, oy] = image.getOrigin();
  const [rx, ry] = image.getResolution();
  const tw = image.getWidth(), th = image.getHeight();
  const bbox = image.getBoundingBox(); // [minLon, minLat, maxLon, maxLat]
  console.log(`TIF bbox: Lon [${bbox[0].toFixed(4)}, ${bbox[2].toFixed(4)}], Lat [${bbox[1].toFixed(4)}, ${bbox[3].toFixed(4)}]`);

  // Compute bounding box in EPSG:6678
  const p0 = toPlane(bbox[0], bbox[1]);
  const p1 = toPlane(bbox[2], bbox[1]);
  const p2 = toPlane(bbox[0], bbox[3]);
  const p3 = toPlane(bbox[2], bbox[3]);

  const minE = Math.min(p0[0], p1[0], p2[0], p3[0]);
  const maxE = Math.max(p0[0], p1[0], p2[0], p3[0]);
  const minN = Math.min(p0[1], p1[1], p2[1], p3[1]);
  const maxN = Math.max(p0[1], p1[1], p2[1], p3[1]);

  const originE = Math.floor(minE / RES) * RES;
  const originN = Math.ceil(maxN / RES) * RES;
  const widthM = Math.ceil((maxE - originE) / RES) * RES;
  const heightM = Math.ceil((originN - minN) / RES) * RES;
  const nx = Math.round(widthM / RES);
  const ny = Math.round(heightM / RES);

  console.log(`Outer backdrop grid: ${nx} x ${ny} @ ${RES}m (${(widthM/1000).toFixed(1)}km x ${(heightM/1000).toFixed(1)}km)`);
  console.log(`Origin: E${originE}, N${originN}`);

  const rasters = await image.readRasters({ interleave: true });
  const raster = rasters;

  const sample = (lon, lat) => {
    const fx = (lon - ox) / rx;
    const fy = (lat - oy) / ry;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    if (x0 < 0 || y0 < 0 || x0 >= tw - 1 || y0 >= th - 1) return -20;
    const wx = fx - x0, wy = fy - y0;
    const v = (x, y) => {
      const h = raster[y * tw + x];
      return (h < -9000 || Number.isNaN(h)) ? -20 : h;
    };
    return (v(x0, y0) * (1 - wx) + v(x0 + 1, y0) * wx) * (1 - wy) +
           (v(x0, y0 + 1) * (1 - wx) + v(x0 + 1, y0 + 1) * wx) * wy;
  };

  const ground = new Float32Array(nx * ny);
  let minH = Infinity, maxH = -Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const [lon, lat] = toLonLat(originE + (i + 0.5) * RES, originN - (j + 0.5) * RES);
      const h = sample(lon, lat);
      ground[j * nx + i] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'ground.f32'), Buffer.from(ground.buffer));
  console.log(`Ground elevation range: [${minH.toFixed(1)}m, ${maxH.toFixed(1)}m]`);

  console.log('Stitching aerial imagery for backdrop...');
  const aerial = await buildAerial({
    outFile: path.join(outDir, 'aerial.jpg'),
    cacheDir,
    originE,
    originN,
    widthM,
    heightM,
    zoom: 12,
    maxPx: 2048,
    metersPerPx: 20,
  });

  const meta = {
    name: 'outer',
    label: '宮古市・三陸リアス広域背景 (miyako.tif)',
    label_en: 'Miyako & Sanriku Coast Backdrop (miyako.tif)',
    nx,
    ny,
    res: RES,
    widthM,
    heightM,
    crs: 'EPSG:6678',
    originE,
    originN,
    groundMin: minH,
    groundMax: maxH,
    aerial,
    demSource: 'miyako.tif (1 arc-second DEM)',
    built: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log(`Done outer backdrop: aerial ${aerial.width}x${aerial.height}px.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
