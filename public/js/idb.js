/**
 * idb.js — envoltorio mínimo sobre IndexedDB (la base de datos NoSQL local del navegador).
 * Cada dispositivo (portátil / celular) tiene su propia copia local aquí; drive-sync.js
 * se encarga de fusionarla con el archivo maestro guardado en Google Drive.
 */

const DB_NAME = 'prestamos_db';
const DB_VERSION = 3; // subido al agregar 'capital' (inyecciones de capital) — fuerza la creación del almacén
const COLECCIONES = ['clientes', 'prestamos', 'abonos', 'rutas', 'cobradores', 'capital'];

let _dbPromise = null;

function abrirDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      COLECCIONES.forEach((nombre) => {
        if (!db.objectStoreNames.contains(nombre)) {
          db.createObjectStore(nombre, { keyPath: 'id' });
        }
      });
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(nombre, modo) {
  return abrirDB().then((db) => db.transaction(nombre, modo).objectStore(nombre));
}

// -------------------------------------------------------------------------
// Colecciones (clientes / prestamos / abonos)
// -------------------------------------------------------------------------

async function obtenerTodos(coleccion) {
  const store = await tx(coleccion, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function obtenerPorId(coleccion, id) {
  const store = await tx(coleccion, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function guardar(coleccion, objeto) {
  const store = await tx(coleccion, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(objeto);
    req.onsuccess = () => resolve(objeto);
    req.onerror = () => reject(req.error);
  });
}

// Reemplaza TODA la colección local por el mapa fusionado (usado tras sincronizar).
async function reemplazarColeccion(coleccion, mapaObjetos) {
  const db = await abrirDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(coleccion, 'readwrite');
    const store = t.objectStore(coleccion);
    store.clear();
    Object.values(mapaObjetos).forEach((obj) => store.put(obj));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// -------------------------------------------------------------------------
// kv (config y metadatos de sincronización: un solo registro por "key")
// -------------------------------------------------------------------------

async function kvGet(key, porDefecto) {
  const store = await tx('kv', 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : porDefecto);
    req.onerror = () => reject(req.error);
  });
}

async function kvSet(key, value) {
  const store = await tx('kv', 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put({ key, value });
    req.onsuccess = () => resolve(value);
    req.onerror = () => reject(req.error);
  });
}

window.idb = { obtenerTodos, obtenerPorId, guardar, reemplazarColeccion, kvGet, kvSet, COLECCIONES };
