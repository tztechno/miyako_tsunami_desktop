// Detail tiles built inside the app, kept in IndexedDB (persists in the browser / the app's WebView storage).
// One record per tile: { name, meta, files: { 'ground.f32': ArrayBuffer, 'aerial.jpg': Blob, ... } }.
const DB = 'miyako-tsunami', STORE = 'tiles';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out.result ?? out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function saveTile(name, meta, files) {
  await tx('readwrite', (s) => s.put({ name, meta, files }));
}

export async function getTile(name) {
  return tx('readonly', (s) => s.get(name));
}

export async function deleteTile(name) {
  await tx('readwrite', (s) => s.delete(name));
}

/** Metadata of the stored tiles, newest first. */
export async function listTiles() {
  try {
    const all = await tx('readonly', (s) => s.getAll());
    return all.map(({ meta }) => meta).sort((a, b) => (a.built < b.built ? 1 : -1));
  } catch {
    return [];
  }
}
