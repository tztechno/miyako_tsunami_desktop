import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPlane } from './lib/proj.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDirTaro = path.join(appRoot, 'public', 'data', 'regions', 'taro');
const outDirMiyako = path.join(appRoot, 'public', 'data', 'regions', 'miyako_port');

// 旧田老防潮堤 第一防潮堤（陸側・現存部）
//   出典: © OpenStreetMap contributors (ODbL) barrier=sea_wall
//         way 788176993 → 1381828264 → 1381828263 を連結
//   検証: 地理院 空中写真 gazo1(1974-78) / toho1(2011震災直後) / seamlessphoto・ort(震災後)
//         のいずれでも堤体と一致。DEM5A 上にも同位置に盛土の稜線あり。
//
// 旧田老防潮堤 海側（X字のもう一方, 2011年に破壊）と新田老防潮堤 (TP+14.7m) は 2026-10-30 に
// 地理院の空中写真を判読して線を引いた（判読の誤差は 5〜10m 程度）。
//
// 収録しないもの（正確な位置が不明のため）:
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

// 旧田老防潮堤 海側: 第一防潮堤の折れ点から南南西へ田老川の右岸沿い（南脚）と、東へ漁港の北側（東脚）。
//   出典: 地理院 空中写真 gazo1 (1974-78年, z17) の判読。南脚は 2012年の5mメッシュ標高に残る高まりと
//   1セル程度で一致。東脚は写真で確認（メッシュ標高には高まりが残っていない）。
const taroSeawardWall = [
  [141.97037, 39.73161],
  [141.97070, 39.73178],
  [141.97107, 39.73203],
  [141.97131, 39.73236],
  [141.97150, 39.73277],
  [141.97164, 39.73326],
  [141.97172, 39.73376],
  [141.97180, 39.73438],
  [141.97190, 39.73491],
  [141.97207, 39.73524], // 第一防潮堤の折れ点（X字の交点）
  [141.97231, 39.73562],
  [141.97284, 39.73584],
  [141.97381, 39.73597],
  [141.97724, 39.73625],
  [141.97816, 39.73665], // 東の丘（DEM5A で地盤 15m）
];

// 新田老防潮堤 (TP+14.7m): 南の丘 → 浜側の堤（南脚）→ 北東へ → 田老川の水門 → 漁港の北側。
//   出典: 地理院 シームレス空中写真 (z17/z18) の判読。南脚と漁港北側は DEM の盛土の稜線（工事中で 10〜14m）と一致。
//   漁港北側の区間は © OpenStreetMap contributors (ODbL) barrier=sea_wall way 1559362887。
const taroNewWall = [
  [141.96985, 39.72937], // 南の丘（DEM5A で地盤 21m）
  [141.96989, 39.72955],
  [141.96997, 39.73013],
  [141.97005, 39.73054],
  [141.97021, 39.73108],
  [141.97059, 39.73227],
  [141.97096, 39.73310],
  [141.97134, 39.73380],
  [141.97150, 39.73401],
  [141.97383, 39.73493],
  [141.97396, 39.73493],
  [141.97378, 39.73557],
  [141.9734971, 39.735941], // ここから way 1559362887
  [141.9737545, 39.7360008],
  [141.9739078, 39.7360364],
  [141.9741924, 39.7360718],
  [141.9763636, 39.7362978],
  [141.9771493, 39.7363845],
  [141.97817, 39.73683], // 東の丘（DEM5A で地盤 20m）
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
    source: '© OpenStreetMap contributors (ODbL); 地理院 空中写真の判読',
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
      },
      {
        id: 'historic_seaward',
        name: '旧田老防潮堤（海側・2011年に破壊）',
        name_en: 'Historic Taro Seawall (Seaward Wall, Destroyed 2011)',
        type: 'historic_seaward',
        defaultHeight: 10.0,
        heightRange: [0, 20],
        width: 4.5,
        baseWidth: 20.0,
        color: '#ff8a65',
        points: transformLine(taroSeawardWall, 10.0),
        description: '第一防潮堤の海側へ増設され、第一防潮堤と X 字に交わった防潮堤。高さ海抜10m。2011年の津波で破壊された。位置は1974-78年の空中写真の判読。',
        description_en: 'Added seaward of the first wall, crossing it in an X. 10m above sea level. Destroyed by the 2011 tsunami. Traced from 1974-78 aerial photos.'
      },
      {
        id: 'new_taro',
        name: '新田老防潮堤（TP+14.7m）',
        name_en: 'New Taro Seawall (TP+14.7m)',
        type: 'new',
        defaultHeight: 14.7,
        heightRange: [0, 22],
        width: 3.0,
        baseWidth: 40.0,
        color: '#4fc3f7',
        points: transformLine(taroNewWall, 14.7),
        osmWays: [1559362887],
        description: '震災後、旧海側防潮堤の位置に建設された高さ T.P.+14.7m の防潮堤。位置は最新の空中写真と DEM の盛土の稜線から判読（漁港北側は OpenStreetMap）。',
        description_en: 'Built after 2011 on the line of the destroyed seaward wall, crest T.P.+14.7m. Traced from recent aerial photos and the embankment ridge in the DEM (OpenStreetMap north of the fishing port).'
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
