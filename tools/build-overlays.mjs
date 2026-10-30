// Build comparison overlays for each region:
//   hazard_tsunami.png  津波浸水想定 (重ねるハザードマップ, 岩手県公表の最大クラス) — RGBA overlay
//   aerial_2011.jpg     東日本大震災 震災直後正射画像 (地理院 toho1, 2011年3〜4月撮影)
//   aerial_1975.jpg     震災前の空中写真 (地理院 gazo1, 1974〜78年撮影)
//   survey2011.json     2011年 津波痕跡の実測値 (東北地方太平洋沖地震津波合同調査グループ)
//
// usage: node tools/build-overlays.mjs [path/to/ttjt_survey_29-Dec-2012_tidecorrected_web.csv]
//   The CSV is downloaded from https://www.coastal.jp/ttjt/ (現地調査結果). Without it, the
//   survey points are skipped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAerial } from './lib/aerial.mjs';
import { toPlane } from './lib/proj.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(appRoot, '.cache', 'gsi');
const REGIONS = ['taro', 'miyako_port'];

const HAZARD_URL = 'https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data/{z}/{x}/{y}.png';
const TOHO1_URL = 'https://cyberjapandata.gsi.go.jp/xyz/toho1/{z}/{x}/{y}.jpg';
const GAZO1_URL = 'https://cyberjapandata.gsi.go.jp/xyz/gazo1/{z}/{x}/{y}.jpg';

/** Parse the TTJT tide-corrected CSV (row 1 = count, row 2 = header). Location names are Shift_JIS and unused. */
function parseSurvey(csvPath) {
  const lines = fs.readFileSync(csvPath, 'latin1').split(/\r?\n/);
  const header = lines[1].split(',').map((h) => h.split('[')[0].trim());
  const col = (name) => header.indexOf(name);
  const c = {
    id: col('ID'), lon: col('lon'), lat: col('lat'), tp: col('height from TP'),
    type: col('type'), rel: col('reliability'), target: col('target'),
  };
  const out = [];
  for (const line of lines.slice(2)) {
    const f = line.split(',');
    const lon = parseFloat(f[c.lon]);
    const lat = parseFloat(f[c.lat]);
    const h = parseFloat(f[c.tp]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(h)) continue;
    out.push({
      id: (f[c.id] || '').trim(),
      lon, lat,
      h, // tsunami height above T.P. (m)
      type: (f[c.type] || '').trim(), // I = inundation height, R = run-up height
      reliability: (f[c.rel] || '').trim(), // A (best) .. D
    });
  }
  return out;
}

async function main() {
  const csvPath = process.argv[2];
  const survey = csvPath && fs.existsSync(csvPath) ? parseSurvey(csvPath) : null;
  if (csvPath && !survey) console.warn(`survey CSV not found: ${csvPath}`);

  for (const name of REGIONS) {
    const dir = path.join(appRoot, 'public', 'data', 'regions', name);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const widthM = meta.nx * meta.res;
    const heightM = meta.ny * meta.res;
    const base = { cacheDir, originE: meta.originE, originN: meta.originN, widthM, heightM, metersPerPx: 2.5, maxPx: 1600 };
    console.log(`\n=== ${name} ===`);

    const force = process.argv.includes('--force');
    const hazardFile = path.join(dir, 'hazard_tsunami.png');
    if (force || !fs.existsSync(hazardFile)) {
      await buildAerial({ ...base, maxPx: Math.max(1600, Math.round(widthM / 2.5)), outFile: hazardFile, zoom: 16, tileUrl: HAZARD_URL, cacheTag: 'tsunami_', transparent: true });
    }
    const photoFile = path.join(dir, 'aerial_2011.jpg');
    if (force || !fs.existsSync(photoFile)) {
      await buildAerial({ ...base, maxPx: Math.max(1600, Math.round(widthM / 2.5)), outFile: photoFile, zoom: 16, tileUrl: TOHO1_URL, cacheTag: 'toho1_' });
    }
    const photo1975File = path.join(dir, 'aerial_1975.jpg');
    if (force || !fs.existsSync(photo1975File)) {
      await buildAerial({ ...base, maxPx: Math.max(1600, Math.round(widthM / 2.5)), outFile: photo1975File, zoom: 16, tileUrl: GAZO1_URL, cacheTag: 'gazo1_' });
    }

    if (survey) {
      const pts = [];
      for (const s of survey) {
        if (s.reliability !== 'A' && s.reliability !== 'B') continue;
        const [e, n] = toPlane(s.lon, s.lat);
        const x = e - meta.originE;
        const z = meta.originN - n;
        if (x < 0 || z < 0 || x >= widthM || z >= heightM) continue;
        pts.push({ ...s, x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 });
      }
      const doc = {
        source: '東北地方太平洋沖地震津波合同調査グループ統一データセット, release 29-Dec-2012 (tide corrected), https://www.coastal.jp/ttjt/',
        note: 'h = 津波高 (T.P.基準). type I = 浸水高, R = 遡上高. 信頼度A・Bのみ収録。',
        points: pts,
      };
      fs.writeFileSync(path.join(dir, 'survey2011.json'), JSON.stringify(doc));
      console.log(`  survey2011: ${pts.length} points (reliability A/B)`);
    }
  }
}

main();
