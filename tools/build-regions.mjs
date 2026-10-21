import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPlane } from './lib/proj.mjs';
import { buildDem } from './lib/dem.mjs';
import { buildAerial } from './lib/aerial.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const cacheDir = path.join(appRoot, '.cache', 'gsi');

const REGIONS = [
  {
    name: 'taro',
    label: '田老地区（旧田老防潮堤）',
    label_en: 'Taro District (Historic Seawall)',
    lat: 39.7368,
    lon: 141.9720,
    originE: 95600,
    originN: -26600,
    widthM: 8000, // 8km East-West: expanded 4km further offshore to observe incoming tsunami waves
    heightM: 4000, // 4km North-South
    res: 5,
    zoomAerial: 15,
    seaFloorDepth: -35,
  },
  {
    name: 'miyako_port',
    label: '宮古港・鍬ヶ崎・閉伊川河口',
    label_en: 'Miyako Port & Hei River Estuary',
    lat: 39.6410,
    lon: 141.9560,
    originE: 94360,
    originN: -37255,
    widthM: 8000, // 8km East-West: expanded into outer ocean off Miyako Bay
    heightM: 4000,
    res: 5,
    zoomAerial: 15,
    seaFloorDepth: -35,
  },
];

async function main() {
  const targetName = process.argv[2];
  const force = process.argv.includes('--force');
  for (const reg of REGIONS) {
    if (targetName && reg.name !== targetName && !force) continue;
    console.log(`\n=== Building region: ${reg.name} (${reg.label}) ===`);
    const widthM = reg.widthM || reg.size;
    const heightM = reg.heightM || reg.size;
    const nx = Math.round(widthM / reg.res);
    const ny = Math.round(heightM / reg.res);
    let originE = reg.originE;
    let originN = reg.originN;
    if (originE === undefined || originN === undefined) {
      const [cE, cN] = toPlane(reg.lon, reg.lat);
      originE = Math.round((cE - (nx * reg.res) / 2) / reg.res) * reg.res;
      originN = Math.round((cN + (ny * reg.res) / 2) / reg.res) * reg.res;
    }
    const outDir = path.join(appRoot, 'public', 'data', 'regions', reg.name);
    fs.mkdirSync(outDir, { recursive: true });

    const groundFile = path.join(outDir, 'ground.f32');
    const aerialFile = path.join(outDir, 'aerial.jpg');

    let minH = 0, maxH = 50;
    // 1. DEM
    if (force || !fs.existsSync(groundFile)) {
      const resDem = await buildDem({
        cacheDir,
        originE,
        originN,
        nx,
        ny,
        res: reg.res,
        zoom: 15,
        seaFloorDepth: reg.seaFloorDepth,
      });
      minH = resDem.minH;
      maxH = resDem.maxH;
      fs.writeFileSync(groundFile, Buffer.from(resDem.dem.buffer));
    } else {
      console.log('ground.f32 already exists, reading...');
      const buf = fs.readFileSync(groundFile);
      const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      minH = Math.min(...f32.filter(v => !isNaN(v)));
      maxH = Math.max(...f32.filter(v => !isNaN(v)));
    }

    // 2. Aerial
    let aerialImg = { width: 1024, height: 1024 };
    if (force || !fs.existsSync(aerialFile)) {
      aerialImg = await buildAerial({
        outFile: aerialFile,
        cacheDir,
        originE,
        originN,
        widthM,
        heightM,
        zoom: reg.zoomAerial,
        metersPerPx: reg.res,
      });
    } else {
      console.log('aerial.jpg already exists.');
    }

    const meta = {
      name: reg.name,
      label: reg.label,
      label_en: reg.label_en,
      nx,
      ny,
      res: reg.res,
      crs: 'EPSG:6678',
      originE,
      originN,
      center: { lat: reg.lat, lon: reg.lon },
      widthM,
      heightM,
      groundMin: minH,
      groundMax: maxH,
      aerial: aerialImg,
      built: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  }

  // Build index
  const allIndex = [];
  for (const reg of REGIONS) {
    const metaFile = path.join(appRoot, 'public', 'data', 'regions', reg.name, 'meta.json');
    if (fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      allIndex.push({
        name: reg.name,
        label: reg.label,
        label_en: reg.label_en,
        nx: meta.nx,
        ny: meta.ny,
        res: meta.res,
        widthM: meta.widthM || meta.nx * meta.res,
        heightM: meta.heightM || meta.ny * meta.res,
        originE: meta.originE,
        originN: meta.originN,
        center: meta.center,
        groundMin: meta.groundMin,
        groundMax: meta.groundMax,
      });
    }
  }
  fs.writeFileSync(path.join(appRoot, 'public', 'data', 'regions', 'index.json'), JSON.stringify(allIndex, null, 2));
  console.log('\nAll regions built successfully!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
