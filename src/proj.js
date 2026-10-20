// JGD2011 / Japan Plane Rectangular CS X (EPSG:6678) — Iwate
import proj4 from 'proj4';

export const EPSG6678 =
  '+proj=tmerc +lat_0=40 +lon_0=140.8333333333333 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

const conv = proj4('EPSG:4326', EPSG6678);

/** [lon, lat] (deg) -> [E, N] (m) */
export function toPlane(lon, lat) {
  return conv.forward([lon, lat]);
}

/** [E, N] (m) -> [lon, lat] (deg) */
export function toLonLat(e, n) {
  return conv.inverse([e, n]);
}

/** Tokyo Peil elevation */
export const toTP = (z) => z;
