import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPlane } from './lib/proj.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(appRoot, '..');
const bldgDir = path.join(projectRoot, '03202_miyako-shi_city_2025_citygml_1_op', 'udx', 'bldg');

const REGION_CONFIGS = [
  {
    name: 'taro',
    metaPath: path.join(appRoot, 'public', 'data', 'regions', 'taro', 'meta.json'),
    filterPrefix: '594147',
    maxBuildings: 8000,
  },
  {
    name: 'miyako_port',
    metaPath: path.join(appRoot, 'public', 'data', 'regions', 'miyako_port', 'meta.json'),
    filterPrefix: '594137',
    maxBuildings: 10000,
  },
];

function parseBldgFile(filePath, originE, originN, W, H) {
  const content = fs.readFileSync(filePath, 'utf8');
  const bldgs = content.split('<core:cityObjectMember>');
  const results = [];

  for (let i = 1; i < bldgs.length; i++) {
    const b = bldgs[i];
    const hMatch = b.match(/<bldg:measuredHeight[^>]*>([\d\.]+)<\/bldg:measuredHeight>/);
    const posMatch = b.match(/<gml:posList>([^<]+)<\/gml:posList>/);
    if (!posMatch) continue;

    const height = hMatch ? parseFloat(hMatch[1]) : 6.5;
    const coords = posMatch[1].trim().split(/\s+/).map(Number);
    if (coords.length < 6) continue;

    let minE = Infinity, maxE = -Infinity;
    let minN = Infinity, maxN = -Infinity;

    for (let c = 0; c < coords.length; c += 3) {
      const lat = coords[c];
      const lon = coords[c + 1];
      if (isNaN(lat) || isNaN(lon)) continue;
      const [e, n] = toPlane(lon, lat);
      if (e < minE) minE = e;
      if (e > maxE) maxE = e;
      if (n < minN) minN = n;
      if (n > maxN) maxN = n;
    }

    if (minE === Infinity) continue;

    // Center in region coordinates: x from 0 to W, z from 0 to H
    const centerE = (minE + maxE) / 2;
    const centerN = (minN + maxN) / 2;
    const x = centerE - originE;
    const z = originN - centerN;

    // Check if within bounds
    if (x >= 0 && x <= W && z >= 0 && z <= H) {
      const w = Math.max(5, Math.min(80, maxE - minE));
      const d = Math.max(5, Math.min(80, maxN - minN));
      results.push({
        x: Math.round(x * 10) / 10,
        z: Math.round(z * 10) / 10,
        w: Math.round(w * 10) / 10,
        d: Math.round(d * 10) / 10,
        h: Math.round(height * 10) / 10,
      });
    }
  }

  return results;
}

async function main() {
  if (!fs.existsSync(bldgDir)) {
    console.error('bldgDir not found at', bldgDir);
    return;
  }
  const allGmlFiles = fs.readdirSync(bldgDir).filter(f => f.endsWith('.gml'));

  for (const cfg of REGION_CONFIGS) {
    if (!fs.existsSync(cfg.metaPath)) {
      console.log(`Skipping ${cfg.name}: meta.json missing`);
      continue;
    }

    console.log(`\n=== Extracting PLATEAU 3D Buildings for ${cfg.name} ===`);
    const meta = JSON.parse(fs.readFileSync(cfg.metaPath, 'utf8'));
    const W = meta.nx * meta.res;
    const H = meta.ny * meta.res;
    const originE = meta.originE;
    const originN = meta.originN;

    const gmlFiles = allGmlFiles.filter(f => f.startsWith(cfg.filterPrefix));
    console.log(`Found ${gmlFiles.length} GML files for prefix ${cfg.filterPrefix}`);

    let allBuildings = [];
    for (const file of gmlFiles) {
      const filePath = path.join(bldgDir, file);
      try {
        const list = parseBldgFile(filePath, originE, originN, W, H);
        allBuildings.push(...list);
        if (allBuildings.length >= cfg.maxBuildings) {
          allBuildings = allBuildings.slice(0, cfg.maxBuildings);
          break;
        }
      } catch (err) {
        console.error(`Error parsing ${file}:`, err.message);
      }
    }

    console.log(`Extracted ${allBuildings.length} buildings for ${cfg.name}`);
    const outFile = path.join(appRoot, 'public', 'data', 'regions', cfg.name, 'buildings.json');
    fs.writeFileSync(outFile, JSON.stringify(allBuildings));
    console.log(`Saved: ${outFile}`);
  }
}

main().catch(console.error);
