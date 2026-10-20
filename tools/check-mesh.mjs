import fs from 'node:fs';
import path from 'node:path';

// 2次メッシュコードの緯度経度範囲を計算
function mesh2toBbox(code) {
  const c = String(code);
  const lat1 = parseInt(c.slice(0, 2), 10) / 1.5;
  const lon1 = parseInt(c.slice(2, 4), 10) + 100;
  const lat2 = parseInt(c[4], 10) * (5 / 60);
  const lon2 = parseInt(c[5], 10) * (7.5 / 60);

  const minLat = lat1 + lat2;
  const maxLat = minLat + (5 / 60);
  const minLon = lon1 + lon2;
  const maxLon = minLon + (7.5 / 60);
  return { minLat, maxLat, minLon, maxLon };
}

const meshes = ['594117', '594127', '594137', '594147', '594157'];
console.log('=== 2nd Mesh Bounding Boxes ===');
for (const m of meshes) {
  const bb = mesh2toBbox(m);
  console.log(`${m}: Lat [${bb.minLat.toFixed(4)}, ${bb.maxLat.toFixed(4)}], Lon [${bb.minLon.toFixed(4)}, ${bb.maxLon.toFixed(4)}]`);
}

// Check bldg files in 594157 (Taro) and 594127 (Miyako port)
const bldgDir = path.resolve('../03202_miyako-shi_city_2025_citygml_1_op/udx/bldg');
const bldgFiles = fs.readdirSync(bldgDir);
const taroBldgs = bldgFiles.filter(f => f.startsWith('594157'));
const miyakoBldgs = bldgFiles.filter(f => f.startsWith('594127'));
console.log(`\nBldg in 594157 (Taro area): ${taroBldgs.length} files`);
console.log(taroBldgs);
console.log(`\nBldg in 594127 (Miyako central area): ${miyakoBldgs.length} files`);
console.log(miyakoBldgs.slice(0, 10));
