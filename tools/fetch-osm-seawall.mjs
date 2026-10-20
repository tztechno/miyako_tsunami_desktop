import fs from 'node:fs';

const bbox = '39.725,141.960,39.750,141.990';
const query = `[out:json][timeout:25];(way["man_made"="dyke"](${bbox});way["barrier"~"wall|retaining_wall"](${bbox});way["name"~"防潮堤|堤防"](${bbox}););out body;>;out skel qt;`;

async function main() {
  const url = 'https://overpass-api.de/api/interpreter';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'MiyakoTsunamiSimulator/1.0 (contact: test@example.com)'
    },
    body: `data=${encodeURIComponent(query)}`
  });
  console.log('Status:', res.status);
  if (!res.ok) {
    console.log(await res.text());
    return;
  }
  const data = await res.json();
  console.log(`Elements: ${data.elements.length}`);
  fs.mkdirSync('.cache', { recursive: true });
  fs.writeFileSync('.cache/taro_osm.json', JSON.stringify(data, null, 2));
}

main().catch(console.error);
