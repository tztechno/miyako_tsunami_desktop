// 2011 actual inundation, 5 m mesh (復興支援調査アーカイブ 宮古市-浸水メッシュ(5m),
// 国土交通省都市局, JGD2000 平面直角座標系第X系). The 5 m squares coincide with the simulation
// grid cells, so the data is written cell-for-cell:
//   inund2011_5m.png  RGBA overlay (standard depth legend), one pixel per cell
//   inund2011_5m.bin  Uint16 per cell: depth × 100 (cm); 0 = surveyed, not flooded;
//                     65534 = flooded, depth unknown (source value 9999); 65535 = no data
//
// usage: node tools/build-inund2011-5m.mjs ../DOCS/fukkou/mesh5.shp
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGIONS = ['taro', 'miyako_port'];
const NODATA = 65535;
const UNKNOWN = 65534; // source uses 9999 for flooded cells without a depth value
const UNKNOWN_COLOR = [0xbd, 0xbd, 0xbd];
const LEGEND = [
  [0.3, [0xff, 0xff, 0xb3]], [0.5, [0xf7, 0xf5, 0xa9]], [1, [0xf8, 0xe1, 0xa6]], [3, [0xff, 0xd8, 0xc0]],
  [5, [0xff, 0xb7, 0xb7]], [10, [0xff, 0x91, 0x91]], [20, [0xf2, 0x85, 0xc9]], [Infinity, [0xdc, 0x7a, 0xdc]],
];

/** Read one numeric DBF column (ASCII) for every record. */
function readDbfNumber(file, fieldName) {
  const b = fs.readFileSync(file);
  const nrec = b.readUInt32LE(4);
  const hlen = b.readUInt16LE(8);
  const rlen = b.readUInt16LE(10);
  const dec = new TextDecoder('shift_jis');
  let off = 1;
  let field = null;
  for (let p = 32; b[p] !== 0x0d; p += 32) {
    const name = dec.decode(b.subarray(p, p + 11)).replace(/\0.*$/, '');
    const len = b[p + 16];
    if (name === fieldName) field = { off, len };
    off += len;
  }
  if (!field) throw new Error(`field not found: ${fieldName}`);
  const out = new Float32Array(nrec);
  for (let r = 0; r < nrec; r++) {
    const s = hlen + r * rlen + field.off;
    out[r] = parseFloat(b.toString('latin1', s, s + field.len));
  }
  return out;
}

/** Lower-left corner (min x, min y) of each polygon record. */
function readShpCorners(file) {
  const b = fs.readFileSync(file);
  const xs = [];
  const ys = [];
  for (let p = 100; p < b.length; ) {
    const len = b.readInt32BE(p + 4) * 2;
    // record bbox: Xmin, Ymin at content offsets 4, 12
    xs.push(b.readDoubleLE(p + 12));
    ys.push(b.readDoubleLE(p + 20));
    p += 8 + len;
  }
  return { xs, ys };
}

function main() {
  const shpPath = process.argv[2];
  if (!shpPath) throw new Error('usage: node tools/build-inund2011-5m.mjs path/to/mesh5.shp');
  const { xs, ys } = readShpCorners(shpPath);
  const depth = readDbfNumber(shpPath.replace(/\.shp$/i, '.dbf'), '浸水深');
  console.log(`cells: ${xs.length} (attributes: ${depth.length})`);

  for (const name of REGIONS) {
    const dir = path.join(appRoot, 'public', 'data', 'regions', name);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const { nx, ny, res, originE, originN } = meta;
    const grid = new Uint16Array(nx * ny).fill(NODATA);
    const png = new PNG({ width: nx, height: ny });
    let surveyed = 0, flooded = 0;

    for (let k = 0; k < xs.length; k++) {
      // square spans [x, x+5] × [y, y+5]; grid row 0 is the northern edge (originN)
      const gx = Math.round((xs[k] - originE) / res);
      const gz = Math.round((originN - (ys[k] + res)) / res);
      if (gx < 0 || gz < 0 || gx >= nx || gz >= ny) continue;
      const d = depth[k];
      if (!Number.isFinite(d)) continue;
      const i = gz * nx + gx;
      const unknown = d >= 9999 || d < 0;
      grid[i] = unknown ? UNKNOWN : Math.min(UNKNOWN - 1, Math.round(d * 100));
      surveyed++;
      if (unknown || d > 0) {
        flooded++;
        const col = unknown ? UNKNOWN_COLOR : LEGEND.find(([lim]) => d < lim)[1];
        png.data[i * 4] = col[0]; png.data[i * 4 + 1] = col[1]; png.data[i * 4 + 2] = col[2]; png.data[i * 4 + 3] = 255;
      }
    }
    fs.writeFileSync(path.join(dir, 'inund2011_5m.png'), PNG.sync.write(png));
    fs.writeFileSync(path.join(dir, 'inund2011_5m.bin'), Buffer.from(grid.buffer));
    console.log(`  ${name}: surveyed ${surveyed} cells, flooded ${flooded} (${((flooded * res * res) / 1e4).toFixed(1)} ha)`);
  }
}

main();
