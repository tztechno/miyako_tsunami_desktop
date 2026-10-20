import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPlane } from './lib/proj.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDirTaro = path.join(appRoot, 'public', 'data', 'regions', 'taro');
const outDirMiyako = path.join(appRoot, 'public', 'data', 'regions', 'miyako_port');

// 位置が正確に確認できた防潮堤のみを収録する（推定・手打ちの座標は使わない）。
//
// 旧田老防潮堤 第一防潮堤（陸側・現存部）
//   出典: © OpenStreetMap contributors (ODbL) barrier=sea_wall
//         way 788176993 → 1381828264 → 1381828263 を連結
//   検証: 地理院 空中写真 gazo1(1974-78) / toho1(2011震災直後) / seamlessphoto・ort(震災後)
//         のいずれでも堤体と一致。DEM5A 上にも同位置に盛土の稜線あり。
//
// 収録しないもの（正確な位置が不明のため）:
//   - 旧田老防潮堤の海側（X字のもう一方, 2011年に破壊）
//   - 新田老防潮堤 (TP+14.7m)
//   - 宮古港・鍬ヶ崎・閉伊川河口の防潮堤・水門
const taroFirstWall = [
  [141.9672713, 39.7338329],
  [141.9673434, 39.7338708],
  [141.9686103, 39.7341887],
  [141.9697596, 39.7344688],
  [141.9715500, 39.7349297],
  [141.9717207, 39.7350084],
  [141.9718763, 39.7351076],
  [141.9720470, 39.7352476],
  [141.9721114, 39.7353585],
  [141.9721721, 39.7354868],
  [141.9724035, 39.7363823],
  [141.9726381, 39.7373205],
  [141.9728208, 39.7380508],
  [141.9729877, 39.7386488],
  [141.9730977, 39.7390601],
  [141.9731091, 39.7392672],
  [141.9731053, 39.7397309],
  [141.9730787, 39.7397951],
  [141.9730300, 39.7399551],
  [141.9730229, 39.7400673],
];

function transformLine(coords, defaultHeight) {
  return coords.map(([lon, lat]) => {
    const [e, n] = toPlane(lon, lat);
    return { lon, lat, e, n, height: defaultHeight };
  });
}

function main() {
  fs.mkdirSync(outDirTaro, { recursive: true });
  fs.mkdirSync(outDirMiyako, { recursive: true });

  const taroSeawalls = {
    type: 'SeawallCollection',
    region: 'taro',
    source: '© OpenStreetMap contributors (ODbL)',
    seawalls: [
      {
        id: 'historic_first',
        name: '旧田老防潮堤（第一防潮堤・現存部）',
        name_en: 'Historic Taro Seawall (First Wall, Extant)',
        type: 'historic',
        defaultHeight: 10.0,
        heightRange: [0, 20],
        width: 4.5,
        baseWidth: 20.0,
        color: '#ffb74d',
        points: transformLine(taroFirstWall, 10.0),
        osmWays: [788176993, 1381828264, 1381828263],
        description: '昭和三陸津波後に着工し1958年に完成した陸側の第一防潮堤。高さ海抜10m。2011年の津波で越流したが現存する。',
        description_en: 'Landward first wall completed in 1958 after the 1933 Showa Sanriku tsunami. 10m above sea level. Overtopped in 2011 but still standing.'
      }
    ]
  };

  const miyakoSeawalls = {
    type: 'SeawallCollection',
    region: 'miyako_port',
    seawalls: []
  };

  fs.writeFileSync(path.join(outDirTaro, 'seawalls.json'), JSON.stringify(taroSeawalls, null, 2));
  fs.writeFileSync(path.join(outDirMiyako, 'seawalls.json'), JSON.stringify(miyakoSeawalls, null, 2));
  console.log('Seawalls generated: taro=%d, miyako_port=%d', taroSeawalls.seawalls.length, miyakoSeawalls.seawalls.length);
}

main();
