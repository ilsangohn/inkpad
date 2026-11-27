// IndexedDB storage: document metadata, document content (pages + strokes), original PDF bytes.
const DB_NAME = 'lecture-notes';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listMeta() {
  const db = await open();
  const all = await request(db.transaction('meta').objectStore('meta').getAll());
  return all.sort((a, b) => b.updated - a.updated);
}

export async function loadDoc(id) {
  const db = await open();
  return request(db.transaction('docs').objectStore('docs').get(id));
}

export async function loadFile(id) {
  const db = await open();
  const rec = await request(db.transaction('files').objectStore('files').get(id));
  return rec ? new Uint8Array(rec.bytes) : null;
}

export async function saveFile(id, bytes) {
  const db = await open();
  const tx = db.transaction('files', 'readwrite');
  tx.objectStore('files').put({ id, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  return done(tx);
}

export async function saveDoc(doc) {
  const db = await open();
  const tx = db.transaction(['docs', 'meta'], 'readwrite');
  doc.updated = Date.now();
  tx.objectStore('docs').put(doc);
  tx.objectStore('meta').put({
    id: doc.id,
    name: doc.name,
    pageCount: doc.pages.length,
    hasPdf: !!doc.fileId,
    created: doc.created,
    updated: doc.updated,
  });
  return done(tx);
}

export async function renameDoc(id, name) {
  const doc = await loadDoc(id);
  if (!doc) return;
  doc.name = name;
  await saveDoc(doc);
}

export async function deleteDoc(id) {
  const db = await open();
  const doc = await loadDoc(id);
  const tx = db.transaction(['docs', 'meta', 'files'], 'readwrite');
  tx.objectStore('docs').delete(id);
  tx.objectStore('meta').delete(id);
  if (doc?.fileId) tx.objectStore('files').delete(doc.fileId);
  return done(tx);
}
