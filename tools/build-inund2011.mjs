// 2011 actual inundation (100 m mesh) from 復興支援調査アーカイブ (国土交通省都市局
// 東日本大震災津波被災市街地復興支援調査, 宮古市-浸水メッシュ(100m), JGD2000 平面直角座標系第X系).
// Outputs per region:
//   inund2011.png   RGBA overlay coloured with the standard depth legend (same as the hazard map)
//   inund2011.json  mesh squares in region coordinates with depth / water level (for comparison)
//
// usage: node tools/build-inund2011.mjs ../DOCS/fukkou/mesh100.shp
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGIONS = ['taro', 'miyako_port'];
const PX = 2.5; // metres per overlay pixel

// Standard inundation-depth legend (matches DEPTH_LEGEND in src/scene.js)
const LEGEND = [
  [0.3, [0xff, 0xff, 0xb3]], [0.5, [0xf7, 0xf5, 0xa9]], [1, [0xf8, 0xe1, 0xa6]], [3, [0xff, 0xd8, 0xc0]],
  [5, [0xff, 0xb7, 0xb7]], [10, [0xff, 0x91, 0x91]], [20, [0xf2, 0x85, 0xc9]], [Infinity, [0xdc, 0x7a, 0xdc]],
];

function readDbf(file) {
  const b = fs.readFileSync(file);
  const nrec = b.readUInt32LE(4);
  const hlen = b.readUInt16LE(8);
  const rlen = b.readUInt16LE(10);
  const dec = new TextDecoder('shift_jis');
  const fields = [];
  for (let p = 32; b[p] !== 0x0d; p += 32) {
    fields.push({ name: dec.decode(b.subarray(p, p + 11)).replace(/\0.*$/, ''), len: b[p + 16] });
  }
  const rows = [];
  for (let r = 0; r < nrec; r++) {
    let p = hlen + r * rlen + 1;
    const row = {};
    for (const f of fields) {
      row[f.name] = dec.decode(b.subarray(p, p + f.len)).trim();
      p += f.len;
    }
    rows.push(row);
  }
  return rows;
}

/** Polygon shapefile reader (type 5): returns the outer ring of each record as [[x, y], ...]. */
function readShp(file) {
  const b = fs.readFileSync(file);
  const shapes = [];
  let p = 100;
  while (p < b.length) {
    const contentLen = b.readInt32BE(p + 4) * 2;
    const type = b.readInt32LE(p + 8);
    if (type === 5) {
      const numParts = b.readInt32LE(p + 44);
      const numPoints = b.readInt32LE(p + 48);
      const ptsStart = p + 52 + numParts * 4;
      const end = numParts > 1 ? b.readInt32LE(p + 56) : numPoints;
      const ring = [];
      for (let k = 0; k < end; k++) ring.push([b.readDoubleLE(ptsStart + k * 16), b.readDoubleLE(ptsStart + k * 16 + 8)]);
      shapes.push(ring);
    } else {
      shapes.push(null);
    }
    p += 8 + contentLen;
  }
  return shapes;
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function main() {
  const shpPath = process.argv[2];
  if (!shpPath) throw new Error('usage: node tools/build-inund2011.mjs path/to/mesh100.shp');
  const shapes = readShp(shpPath);
  const rows = readDbf(shpPath.replace(/\.shp$/i, '.dbf'));
  console.log(`meshes: ${shapes.length} (attributes: ${rows.length})`);

  for (const name of REGIONS) {
    const dir = path.join(appRoot, 'public', 'data', 'regions', name);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const W = meta.nx * meta.res;
    const H = meta.ny * meta.res;
    const iw = Math.round(W / PX);
    const ih = Math.round(H / PX);
    const png = new PNG({ width: iw, height: ih });
    const meshes = [];

    shapes.forEach((ring, k) => {
      if (!ring) return;
      const depth = parseFloat(rows[k]['浸水深']);
      const wl = parseFloat(rows[k]['浸水高']);
      if (!(depth > 0)) return;
      // shapefile X = easting, Y = northing (JGD2000 zone X ≈ EPSG:6678 at this scale)
      const local = ring.map(([e, n]) => [e - meta.originE, meta.originN - n]);
      const xs = local.map((q) => q[0]);
      const zs = local.map((q) => q[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
      if (x1 < 0 || z1 < 0 || x0 > W || z0 > H) return;
      meshes.push({ id: rows[k]['メッシュID'], ring: local.map(([x, z]) => [+x.toFixed(1), +z.toFixed(1)]), depth, wl });

      const col = LEGEND.find(([lim]) => depth < lim)[1];
      for (let py = Math.max(0, Math.floor(z0 / PX)); py <= Math.min(ih - 1, Math.ceil(z1 / PX)); py++) {
        for (let px = Math.max(0, Math.floor(x0 / PX)); px <= Math.min(iw - 1, Math.ceil(x1 / PX)); px++) {
          if (!pointInRing((px + 0.5) * PX, (py + 0.5) * PX, local)) continue;
          const o = (py * iw + px) * 4;
          png.data[o] = col[0]; png.data[o + 1] = col[1]; png.data[o + 2] = col[2]; png.data[o + 3] = 255;
        }
      }
    });

    fs.writeFileSync(path.join(dir, 'inund2011.png'), PNG.sync.write(png));
    fs.writeFileSync(
      path.join(dir, 'inund2011.json'),
      JSON.stringify({
        source: '復興支援調査アーカイブ 宮古市-浸水メッシュ(100m) / 国土交通省都市局 東日本大震災津波被災市街地復興支援調査',
        note: 'depth = 浸水深(m), wl = 浸水高(m). 正確性は保証されない（出典の注記による）。',
        meshes,
      })
    );
    console.log(`  ${name}: ${meshes.length} inundated meshes in region`);
  }
}

main();
