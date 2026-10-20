import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

async function inspectStream(relPath, maxLines = 35) {
  const full = path.resolve('../03202_miyako-shi_city_2025_citygml_1_op/udx', relPath);
  if (!fs.existsSync(full)) {
    console.log('Not found:', relPath);
    return;
  }
  const stats = fs.statSync(full);
  console.log(`\n=== ${relPath} (Size: ${(stats.size / 1024 / 1024).toFixed(1)} MB) ===`);
  const rl = readline.createInterface({
    input: fs.createReadStream(full, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  });

  let count = 0;
  for await (const line of rl) {
    console.log(line);
    count++;
    if (count >= maxLines) {
      rl.close();
      break;
    }
  }
}

async function run() {
  await inspectStream('dem/594147_dem_6697_op.gml');
  await inspectStream('tnm/03_1/594147_tnm_6697_op.gml');
  await inspectStream('tnm/03_2/594147_tnm_6697_op.gml');
}

run().catch(console.error);
