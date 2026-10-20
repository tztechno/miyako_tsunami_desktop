import fs from 'node:fs';
import path from 'node:path';

const bldgDir = path.resolve('../03202_miyako-shi_city_2025_citygml_1_op/udx/bldg');
const bldgFiles = fs.readdirSync(bldgDir);

const prefixCounts = {};
for (const f of bldgFiles) {
  const p = f.slice(0, 6);
  prefixCounts[p] = (prefixCounts[p] || 0) + 1;
}
console.log('Bldg files by 2nd mesh prefix:', prefixCounts);

// Check 594147 files in bldg
const bldgs594147 = bldgFiles.filter(f => f.startsWith('594147'));
console.log('\n594147 bldg files count:', bldgs594147.length);
console.log(bldgs594147.slice(0, 15));

// Check dem in 594147
const demDir = path.resolve('../03202_miyako-shi_city_2025_citygml_1_op/udx/dem');
const demFiles = fs.readdirSync(demDir);
console.log('\nDEM files:', demFiles);

// Check tnm files
const tnmDir1 = path.resolve('../03202_miyako-shi_city_2025_citygml_1_op/udx/tnm/03_1');
const tnmFiles1 = fs.existsSync(tnmDir1) ? fs.readdirSync(tnmDir1) : [];
console.log('\nTNM 03_1 files:', tnmFiles1);
