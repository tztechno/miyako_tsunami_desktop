/**
 * Position along a region's inflow edges, shared by the simulator (which boundary cell takes which station's wave)
 * and tools/nankai/run-nankai.ts (where the stations are sampled). The edges run counterclockwise: the south edge
 * west to east, the east edge south to north, the north edge east to west; only the region's inflow edges count, so
 * p (metres) is continuous along them.
 */
import { inflowEdges } from './tsunamiSim.js';

const ORDER = ['south', 'east', 'north'];

/** The region's inflow edges in path order with their start p and length (m). */
export function edgeSegments(meta) {
  const W = meta.nx * meta.res, H = meta.ny * meta.res;
  const edges = inflowEdges(meta);
  let p = 0;
  const segs = [];
  for (const e of ORDER) {
    if (!edges.includes(e)) continue;
    const len = e === 'east' ? H : W;
    segs.push({ edge: e, p0: p, len });
    p += len;
  }
  return segs;
}

/** p of a boundary cell (grid x, y). The east columns win at the corners, as in openBoundary. */
export function cellEdgeP(meta, segs, x, y) {
  const { nx, ny, res } = meta;
  const seg = (e) => segs.find((s) => s.edge === e);
  const east = seg('east');
  if (east && x >= nx - 2) return east.p0 + (ny - 1 - y + 0.5) * res;
  if (y === ny - 1 && seg('south')) return seg('south').p0 + (x + 0.5) * res;
  if (y === 0 && seg('north')) return seg('north').p0 + (nx - 1 - x + 0.5) * res;
  return 0;
}

/** Region-local point (x east of the west edge, z south of the north edge, m) at p, `inset` metres inside the edge. */
export function edgePoint(meta, segs, p, inset) {
  const W = meta.nx * meta.res, H = meta.ny * meta.res;
  const s = segs.find((g) => p >= g.p0 && p <= g.p0 + g.len) || segs[segs.length - 1];
  const d = p - s.p0;
  if (s.edge === 'south') return { x: d, z: H - inset };
  if (s.edge === 'east') return { x: W - inset, z: H - d };
  return { x: W - d, z: inset };
}
