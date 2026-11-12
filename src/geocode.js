// Address / place search for the observation pin (from N74 osaka_tsunami, points only): landmark names from
// labels.json first, then the GSI address search (needs a network connection). Hits just outside the current
// region are returned separately, so the UI can say why they get no pin.
import { toPlane } from './proj.js';

const GSI_URL = 'https://msearch.gsi.go.jp/address-search/AddressSearch?q=';
const NEARBY_M = 25000; // out-of-region hits farther than this from the region are dropped (other towns)

/**
 * Candidates for a query: { inside: [{ title, title_en, worldX, worldZ, source: 'label' | 'gsi' }],
 * outside: [{ title, worldX, worldZ }] } (region-local metres: x east of the west edge, z south of the north edge).
 */
export async function searchPlaces(q, meta, landmarks = []) {
  const W = meta.nx * meta.res, H = meta.ny * meta.res;
  const toWorld = (lon, lat) => {
    const [e, n] = toPlane(lon, lat);
    const worldX = e - meta.originE, worldZ = meta.originN - n;
    return { worldX, worldZ, inside: worldX >= 0 && worldZ >= 0 && worldX < W && worldZ < H };
  };
  const nearby = ({ worldX, worldZ }) => Math.hypot(Math.max(0, -worldX, worldX - W), Math.max(0, -worldZ, worldZ - H)) < NEARBY_M;

  const inside = [], outside = [];
  const strip = (s) => s.replace(/^[^\p{L}\p{N}]+/u, '').trim(); // labels start with an emoji
  for (const l of landmarks) {
    if (!l.name.includes(q) && !(l.name_en || '').toLowerCase().includes(q.toLowerCase())) continue;
    const p = toWorld(l.lon, l.lat);
    if (p.inside) inside.push({ title: strip(l.name), title_en: strip(l.name_en || l.name), worldX: p.worldX, worldZ: p.worldZ, source: 'label' });
  }
  let list = [], gsiError = null;
  try {
    list = await (await fetch(GSI_URL + encodeURIComponent(q))).json();
  } catch (e) {
    gsiError = e.message;
  }
  for (const f of list) {
    const [lon, lat] = f.geometry.coordinates;
    const p = toWorld(lon, lat);
    const title = f.properties.title;
    if (!p.inside) {
      if (outside.length < 5 && nearby(p)) outside.push({ title, worldX: p.worldX, worldZ: p.worldZ });
      continue;
    }
    inside.push({ title, title_en: title, worldX: p.worldX, worldZ: p.worldZ, source: 'gsi' });
    if (inside.length >= 15) break;
  }
  if (!inside.length && !outside.length && gsiError) throw new Error(gsiError);
  return { inside, outside };
}
