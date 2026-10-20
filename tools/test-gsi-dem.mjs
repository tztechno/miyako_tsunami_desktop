function lonLatToTile(lon, lat, z) {
  const x = Math.floor(((lon + 180) / 360) * Math.pow(2, z));
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * Math.pow(2, z)
  );
  return { x, y, z };
}

async function checkTile(url) {
  try {
    const res = await fetch(url);
    return { status: res.status, ok: res.ok, size: res.headers.get('content-length') };
  } catch (err) {
    return { error: err.message };
  }
}

async function main() {
  const lat = 39.7368;
  const lon = 141.9686;
  console.log(`Checking GSI tiles for Taro (${lat}, ${lon}):`);

  for (const z of [15, 16]) {
    const tile = lonLatToTile(lon, lat, z);
    const url5a = `https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/${z}/${tile.x}/${tile.y}.png`;
    const url10b = `https://cyberjapandata.gsi.go.jp/xyz/dem10b_png/${z}/${tile.x}/${tile.y}.png`;
    const photoUrl = `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${tile.x}/${tile.y}.jpg`;

    const res5a = await checkTile(url5a);
    const res10b = await checkTile(url10b);
    const resPhoto = await checkTile(photoUrl);
    console.log(`z=${z} (x=${tile.x}, y=${tile.y}):`);
    console.log(`  DEM5A: ${res5a.status} (${res5a.ok ? 'Available' : 'Not available'})`);
    console.log(`  DEM10B: ${res10b.status} (${res10b.ok ? 'Available' : 'Not available'})`);
    console.log(`  Photo: ${resPhoto.status} (${resPhoto.ok ? 'Available' : 'Not available'})`);
  }
}

main().catch(console.error);
