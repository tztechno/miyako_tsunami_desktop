import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { toPlane } from './lib/proj.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(appRoot, '..');
const tnmDir = path.join(projectRoot, '03202_miyako-shi_city_2025_citygml_1_op', 'udx', 'tnm', '03_1');

const REGION_CONFIGS = [
  {
    name: 'taro',
    metaPath: path.join(appRoot, 'public', 'data', 'regions', 'taro', 'meta.json'),
    file: '594147_tnm_6697_op.gml',
    maxPolys: 3000,
  },
  {
    name: 'miyako_port',
    metaPath: path.join(appRoot, 'public', 'data', 'regions', 'miyako_port', 'meta.json'),
    file: '594137_tnm_6697_op.gml',
    maxPolys: 3000,
  },
];

async function parseTnm(filePath, originE, originN, W, H, maxPolys) {
  if (!fs.existsSync(filePath)) return [];

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  const polygons = [];
  let inPosList = false;

  for await (const line of rl) {
    if (line.includes('<gml:posList>')) {
      const match = line.match(/<gml:posList>([^<]+)<\/gml:posList>/);
      if (match) {
        const nums = match[1].trim().split(/\s+/).map(Number);
        if (nums.length >= 9) { // At least 3 vertices
          let sumE = 0, sumN = 0, sumZ = 0, cnt = 0;
          let inside = false;
          for (let i = 0; i < nums.length; i += 3) {
            const lat = nums[i], lon = nums[i + 1], zVal = nums[i + 2];
            const [e, n] = toPlane(lon, lat);
            const rx = e - originE;
            const rz = originN - n;
            if (rx >= 0 && rx <= W && rz >= 0 && rz <= H) {
              inside = true;
            }
            sumE += rx;
            sumN += rz;
            sumZ += zVal;
            cnt++;
          }
          if (inside && cnt > 0) {
            polygons.push({
              x: Math.round((sumE / cnt) * 10) / 10,
              z: Math.round((sumN / cnt) * 10) / 10,
              wse: Math.round((sumZ / cnt) * 10) / 10, // Water Surface Elevation
            });
            if (polygons.length >= maxPolys) {
              rl.close();
              break;
            }
          }
        }
      }
    }
  }

  return polygons;
}

async function main() {
  for (const cfg of REGION_CONFIGS) {
    if (!fs.existsSync(cfg.metaPath)) continue;
    const meta = JSON.parse(fs.readFileSync(cfg.metaPath, 'utf8'));
    const W = meta.nx * meta.res;
    const H = meta.ny * meta.res;
    const gmlPath = path.join(tnmDir, cfg.file);

    console.log(`\n=== Processing TNM for ${cfg.name} (${cfg.file}) ===`);
    const polys = await parseTnm(gmlPath, meta.originE, meta.originN, W, H, cfg.maxPolys);
    console.log(`Extracted ${polys.length} tsunami hazard points for ${cfg.name}`);

    const outFile = path.join(appRoot, 'public', 'data', 'regions', cfg.name, 'tnm.json');
    fs.writeFileSync(outFile, JSON.stringify(polys));
    console.log(`Saved: ${outFile}`);
  }
}

main().catch(console.error);
