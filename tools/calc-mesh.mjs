function coordToMesh(lat, lon) {
  const p = Math.floor(lat * 1.5);
  const q = Math.floor(lon - 100);
  const r = Math.floor((lat * 1.5 - p) * 8);
  const s = Math.floor((lon - 100 - q) * 8);
  const t = Math.floor(((lat * 1.5 - p) * 8 - r) * 10);
  const u = Math.floor(((lon - 100 - q) * 8 - s) * 10);
  const mesh1 = `${p}${q}`;
  const mesh2 = `${mesh1}${r}${s}`;
  const mesh3 = `${mesh2}${t}${u}`;
  return { mesh1, mesh2, mesh3, p, q, r, s, t, u };
}

// Taro station: approx 39.7368, 141.9686
console.log('Taro Station (39.7368, 141.9686):', coordToMesh(39.7368, 141.9686));
// Taro coastline / seawall: approx 39.730 to 39.745, 141.970 to 141.978
console.log('Taro Coast (39.733, 141.973):', coordToMesh(39.733, 141.973));
console.log('Taro Seawall Center (39.736, 141.974):', coordToMesh(39.736, 141.974));

// Miyako Station (39.6414, 141.9472)
console.log('Miyako Station (39.6414, 141.9472):', coordToMesh(39.6414, 141.9472));
