/**
 * config-local.js — TODO lo que es específico de TU negocio/proyecto de Firebase, en un
 * solo archivo aparte. La idea es que este sea el ÚNICO archivo que edites a mano y que
 * NUNCA tengas que volver a tocar cuando te entregue una actualización de la app: los
 * demás archivos (firebase-sync.js, logic.js, etc.) se pueden reemplazar sin miedo a
 * perder tu configuración, siempre y cuando conserves este archivo tal como lo dejaste.
 *
 * Se carga ANTES que logic.js y firebase-sync.js (ver las etiquetas <script> en
 * index.html), así que ambos ya encuentran estas variables definidas cuando las usan.
 */

// Configuración de tu proyecto de Firebase — cópiala desde Firebase Console → ⚙️
// Configuración del proyecto → "Tus apps" → selecciona (o crea) una app web →
// "Configuración del SDK" (ver INSTRUCCIONES.md, Parte 2.4).
const FIREBASE_CONFIG = {
  apiKey: "<VALOR-AQUI>",
  authDomain: "<VALOR-AQUI>",
  projectId: "<VALOR-AQUI>",
  storageBucket: "<VALOR-AQUI>",
  messagingSenderId: "<VALOR-AQUI>",
  appId: "<VALOR-AQUI>"
};

// Cuentas de Google que SIEMPRE pueden entrar a la app y sincronizar, aunque se borren
// por error de la lista blanca de Configuración — para que el dueño nunca quede
// bloqueado de su propia app. Deben coincidir EXACTAMENTE con la lista de
// firestore.rules (función esRespaldo()) — si cambias una, cambia la otra también y
// vuelve a publicar las reglas en Firebase Console.
const CORREOS_RESPALDO = ['correo@gmail.com'];
