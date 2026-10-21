import fs from 'node:fs';
import path from 'node:path';
import { fromFile } from 'geotiff';

async function inspectTif() {
  let tifPath = path.resolve('../miyako.tif');
  if (!fs.existsSync(tifPath)) {
    tifPath = path.resolve('../DOCS/miyako.tif');
  }
  if (!fs.existsSync(tifPath)) {
    console.log('miyako.tif not found at', tifPath);
    return;
  }
  const tiff = await fromFile(tifPath);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY]
  const origin = image.getOrigin();
  const resolution = image.getResolution();
  const geoKeys = image.getGeoKeys();

  console.log('=== miyako.tif Info ===');
  console.log(`Dimensions: ${width} x ${height}`);
  console.log(`BoundingBox:`, bbox);
  console.log(`Origin:`, origin);
  console.log(`Resolution:`, resolution);
  console.log(`GeoKeys:`, geoKeys);

  const rasters = await image.readRasters();
  const data = rasters[0];
  let min = Infinity;
  let max = -Infinity;
  let validCount = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v > -9990 && Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
      validCount++;
    }
  }
  console.log(`Elevation range: min = ${min}, max = ${max}, valid pixels = ${validCount}/${data.length}`);
}

function inspectCityGML() {
  const cPath = path.resolve('../03202_miyako-shi_city_2025_citygml_1_op/udx');
  if (!fs.existsSync(cPath)) {
    console.log('CityGML not found at', cPath);
    return;
  }
  console.log('\n=== CityGML udx Folders ===');
  const dirs = fs.readdirSync(cPath).filter(d => fs.statSync(path.join(cPath, d)).isDirectory());
  for (const dir of dirs) {
    const sub = path.join(cPath, dir);
    const files = fs.readdirSync(sub);
    console.log(`  ${dir}: ${files.length} items`);
    if (files.length > 0 && files.length <= 15) {
      console.log(`    Files:`, files.join(', '));
    } else if (files.length > 15) {
      console.log(`    Sample:`, files.slice(0, 5).join(', '), '...');
    }
  }

  // Check tnm and dem files specifically
  const tnmPath = path.join(cPath, 'tnm');
  if (fs.existsSync(tnmPath)) {
    console.log('\n=== TNM Files ===');
    const tnmSub = fs.readdirSync(tnmPath);
    console.log('TNM subdirs/files:', tnmSub);
    for (const s of tnmSub) {
      const p = path.join(tnmPath, s);
      if (fs.statSync(p).isDirectory()) {
        const f = fs.readdirSync(p);
        console.log(`  ${s}: ${f.length} files. Sample:`, f.slice(0, 5));
      }
    }
  }

  const demPath = path.join(cPath, 'dem');
  if (fs.existsSync(demPath)) {
    console.log('\n=== DEM Files ===');
    const demFiles = fs.readdirSync(demPath);
    console.log(`DEM count: ${demFiles.length}. Sample:`, demFiles.slice(0, 10));
  }
}

async function main() {
  await inspectTif();
  inspectCityGML();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
