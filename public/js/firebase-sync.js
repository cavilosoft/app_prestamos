/**
 * firebase-sync.js — inicio de sesión con Google (Firebase Authentication) y sincroniza
 * los datos locales con un único documento en Cloud Firestore, dentro del MISMO proyecto
 * de Firebase donde ya está publicada la app (el de Firebase Hosting).
 *
 * Reemplaza al anterior drive-sync.js (Google Drive): ya no hace falta pedir un permiso
 * aparte de Google Drive, ni configurar "Usuarios de prueba" en Google Cloud, ni compartir
 * carpetas a mano con cada cobrador — con Firestore, la MISMA sesión con la que se entra a
 * la app sirve también para sincronizar, y quién puede leer/escribir los datos se controla
 * con las Reglas de seguridad de Firestore (ver INSTRUCCIONES.md, "Reglas de Firestore").
 *
 * FIREBASE_CONFIG vive en js/config-local.js (se carga antes que este archivo) — así no
 * hay que volver a pegarla cada vez que este archivo se actualiza.
 */

// Todos los datos viven en un único documento: colección "sync", documento "maestro".
// A la escala de un negocio pequeño esto es simple y suficiente; si algún día crecieras
// mucho (miles de clientes), habría que repartir los datos en varios documentos, porque
// Firestore limita cada documento a 1 MB — dímelo si llegas a ese punto.
const DOC_SYNC = 'sync/maestro';

let _app = null;
let _auth = null;
let _db = null;
let _sincronizando = null;

function _inicializar() {
  if (_app) return;
  if (!window.firebase) throw new Error('No cargó la librería de Firebase (revisa tu conexión a internet).');
  if (!FIREBASE_CONFIG.apiKey || FIREBASE_CONFIG.apiKey.indexOf('TU_API_KEY_AQUI') !== -1) {
    throw new Error('Falta configurar FIREBASE_CONFIG en js/firebase-sync.js con los datos de tu proyecto de Firebase.');
  }
  _app = firebase.initializeApp(FIREBASE_CONFIG);
  _auth = firebase.auth();
  _db = firebase.firestore();
}

// -------------------------------------------------------------------------
// AUTENTICACIÓN
// -------------------------------------------------------------------------

async function iniciarSesionGoogle() {
  _inicializar();
  const proveedor = new firebase.auth.GoogleAuthProvider();
  const resultado = await _auth.signInWithPopup(proveedor);
  return resultado.user;
}

async function cerrarSesion() {
  _inicializar();
  await _auth.signOut();
}

/** cb(user | null) — se llama al cargar la página (con la sesión guardada, si la había) y
 *  cada vez que cambia la sesión (inicio o cierre). */
function onCambioSesion(cb) {
  _inicializar();
  _auth.onAuthStateChanged(cb);
}

function correoActual() {
  if (!_auth || !_auth.currentUser) return null;
  return String(_auth.currentUser.email || '').toLowerCase().trim() || null;
}

// -------------------------------------------------------------------------
// SINCRONIZACIÓN (fusiona local + Firestore y deja ambos lados iguales)
// -------------------------------------------------------------------------

async function sincronizarAhora() {
  if (_sincronizando) return _sincronizando; // ya hay una sincronización en curso
  _sincronizando = _sincronizarInterno().finally(() => { _sincronizando = null; });
  return _sincronizando;
}

async function _sincronizarInterno() {
  try {
    _inicializar();
  } catch (e) {
    return { ok: false, motivo: 'error', mensaje: e.message };
  }
  if (!navigator.onLine) return { ok: false, motivo: 'sin_conexion' };
  if (!_auth.currentUser) return { ok: false, motivo: 'sin_autorizacion' };

  try {
    const ref = _db.doc(DOC_SYNC);
    const snap = await ref.get();
    const remoto = snap.exists ? (snap.data() || {}) : {};

    const aMapa = (arr) => Object.fromEntries((arr || []).map((r) => [r.id, r]));

    // Se fusiona cada colección declarada en idb.COLECCIONES de forma genérica, así que
    // cualquier colección nueva que se agregue en el futuro se sincroniza automáticamente
    // sin tener que tocar este archivo.
    const coleccionesFusionadas = {};
    for (const nombre of idb.COLECCIONES) {
      const local = await idb.obtenerTodos(nombre);
      coleccionesFusionadas[nombre] = logic.fusionarColeccion(aMapa(local), remoto[nombre] || {});
      await idb.reemplazarColeccion(nombre, coleccionesFusionadas[nombre]);
    }

    const localConfig = await idb.kvGet('config');
    const configFusionado = logic.fusionarConfig(localConfig, remoto.config);
    if (configFusionado) await idb.kvSet('config', configFusionado);

    await ref.set(Object.assign({}, coleccionesFusionadas, {
      config: configFusionado || {},
      _meta: { ultimaSincronizacion: logic.nowISO() }
    }));

    await idb.kvSet('lastSyncedAt', logic.nowISO());
    return { ok: true };
  } catch (e) {
    console.error('Error al sincronizar:', e);
    return { ok: false, motivo: 'error', mensaje: e.message };
  }
}

window.firebaseSync = {
  iniciarSesionGoogle, cerrarSesion, onCambioSesion, correoActual, sincronizarAhora
};
