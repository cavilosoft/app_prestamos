/**
 * app.js — interfaz de usuario: navegación, formularios y el indicador de sincronización.
 * Toda la lógica de negocio vive en logic.js (datos locales) y firebase-sync.js (Firebase).
 *
 * La app SÍ exige iniciar sesión con Google para usarse (ver CONTROL DE ACCESO más abajo):
 * solo entran las cuentas que el dueño autorizó en la lista blanca (Configuración → Acceso
 * a la app), más una cuenta de respaldo fija para que el dueño nunca quede fuera de su
 * propia app. Esa misma sesión sirve también para sincronizar contra Firestore — no hace
 * falta un segundo permiso aparte, como pasaba antes con Google Drive.
 *
 * Navegación de "Clientes" (drill-down): lista → detalle de cliente → nuevo/detalle de préstamo.
 * Cada paso queda registrado en las variables de estado de abajo (clienteActualId, prestamoActualId, etc.)
 */

let CONFIG = { interes: 20, seguro: 5, moneda: 'COP' };

// -------------------------------------------------------------------
// INTERRUPTOR DE SINCRONIZACIÓN
// -------------------------------------------------------------------
// Con esto en true, la app intenta conectar Google Drive (en silencio si ya
// hay una conexión previa, o pidiendo permiso cuando el usuario pulsa
// "Sincronizar") y sincroniza en segundo plano cada minuto. Si algún día
// quieres volver a trabajar 100% local, solo cambia esto a `false`.
const SYNC_HABILITADO = true;

let rutasCache = [];
let cobradoresCache = [];
let capitalCache = [];

// Si la cuenta que inició sesión es la del dueño (o cualquier otra sin vincular), esto
// queda en null y ve toda la app. Si el correo coincide con el de un Cobrador registrado,
// aquí queda ese cobrador y la app se restringe a mostrarle solo los clientes de sus rutas.
let restriccionCobrador = null;
let rutasIdsCobradorActual = [];

let clienteActualId = null;
let clienteActual = null;
let prestamoActualId = null;
let prestamoActual = null;

let filtrosClientes = { pagina: 1, tamano: 20, query: '', ciudad: '', idRuta: '', idCobrador: '' };
let filtrosPrestamos = { pagina: 1, tamano: 10, estado: '' };

document.addEventListener('DOMContentLoaded', () => {
  registrarServiceWorker();
  iniciarControlDeAcceso();
});

async function init() {
  aplicarRestriccionCobradorEnUI();

  document.querySelectorAll('#nav button').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
      if (btn.dataset.tab === 'clientes') { mostrarVista('lista'); refrescarListaClientes(); }
      else if (btn.dataset.tab === 'rutas') refrescarRutas();
      else if (btn.dataset.tab === 'cobradores') refrescarCobradores();
      else if (btn.dataset.tab === 'dashboard') { cargarSelectsDashboard(); cargarDashboard(); }
      else if (btn.dataset.tab === 'configuracion') refrescarCapital();
    });
  });

  // CONFIG se necesita siempre (aunque la pestaña Configuración esté oculta para un
  // cobrador), porque también se usa para sugerir el % de interés/seguro al crear préstamos.
  CONFIG = await logic.getConfig();

  await recargarCaches();
  await refrescarListaClientes();
  await actualizarEstadoConexionDrive();
  configurarSincronizacion();

  if (restriccionCobrador) return; // lo de abajo es solo para Dashboard/Rutas/Cobradores/Configuración

  document.getElementById('cfg_interes').value = CONFIG.interes;
  document.getElementById('cfg_seguro').value = CONFIG.seguro;
  document.getElementById('cfg_moneda').value = CONFIG.moneda;
  document.getElementById('cfg_capitalInicial').value = CONFIG.capitalInicial ? money(CONFIG.capitalInicial) : '';
  document.getElementById('cap_fecha').value = logic.hoyISO();
  onTipoCapitalChange();

  await cargarSelectsDashboard();
  await cargarDashboard();
  await refrescarCapital();
  await refrescarListaCorreosAutorizados();
}

function switchTab(tab) {
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
}

/** Cambia de "vista" dentro de la pestaña Clientes (lista / nuevoCliente / detalleCliente / nuevoPrestamo / detallePrestamo). */
function mostrarVista(nombre) {
  document.querySelectorAll('#tab-clientes .vista').forEach((v) => { v.style.display = 'none'; });
  document.getElementById('vc_' + nombre).style.display = '';
}

async function recargarCaches() {
  rutasCache = await logic.listarRutas();
  cobradoresCache = await logic.listarCobradores();
}

function nombreRuta(idRuta) {
  const r = rutasCache.find((x) => x.id === idRuta);
  return r ? r.Nombre : '—';
}

function nombreCobradorDeRuta(idRuta) {
  const r = rutasCache.find((x) => x.id === idRuta);
  if (!r || !r.ID_Cobrador) return '—';
  const c = cobradoresCache.find((x) => x.id === r.ID_Cobrador);
  return c ? c.Nombre : '—';
}

// -------------------------------------------------------------------
// UTILIDADES DE UI
// -------------------------------------------------------------------

function money(n) {
  n = Number(n) || 0;
  try {
    return n.toLocaleString('es-CO', { style: 'currency', currency: CONFIG.moneda || 'COP', maximumFractionDigits: 0 });
  } catch (e) {
    return (CONFIG.moneda || '') + ' ' + n.toLocaleString('es-CO');
  }
}

function mostrarMsg(contenedorId, texto, tipo) {
  const el = document.getElementById(contenedorId);
  el.innerHTML = '<div class="msg ' + tipo + '">' + texto + '</div>';
  if (tipo === 'ok') setTimeout(() => { el.innerHTML = ''; }, 4000);
}

function manejarError(err, contenedorId) {
  const texto = (err && err.message) ? err.message : String(err);
  mostrarMsg(contenedorId, '⚠️ ' + texto, 'error');
}

// -------------------------------------------------------------------
// MODAL GENÉRICO (reemplaza confirm()/alert() nativos del navegador)
// -------------------------------------------------------------------

let _modalOnConfirmar = null;

function abrirModal(titulo, cuerpoHtml, onConfirmar, textoConfirmar) {
  document.getElementById('modalTitulo').textContent = titulo;
  document.getElementById('modalCuerpo').innerHTML = cuerpoHtml;
  document.getElementById('modalMsg').innerHTML = '';
  document.getElementById('modalBtnConfirmar').textContent = textoConfirmar || 'Confirmar';
  _modalOnConfirmar = onConfirmar;
  document.getElementById('modalOverlay').style.display = 'flex';
}

function cerrarModal() {
  document.getElementById('modalOverlay').style.display = 'none';
  _modalOnConfirmar = null;
}

function onClicOverlayModal(ev) {
  if (ev.target && ev.target.id === 'modalOverlay') cerrarModal();
}

async function onClicConfirmarModal() {
  if (typeof _modalOnConfirmar === 'function') {
    await _modalOnConfirmar();
  }
}

function setCargando(btnId, cargando, textoNormal) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = cargando;
  btn.innerHTML = cargando ? (textoNormal + '<span class="spinner"></span>') : textoNormal;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Iniciales para el avatar circular de las listas (ej: "Ana Milena Botello Suárez" -> "AS").
function iniciales(nombre) {
  const partes = String(nombre || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '?';
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

function round1(n) { return Math.round(Number(n) * 10) / 10; }
function round2(n) { return Math.round(Number(n) * 100) / 100; }

// Quita todo lo que no sea dígito (símbolo de moneda, puntos de miles, espacios).
function limpiarNumero(valorFormateado) {
  if (!valorFormateado) return 0;
  const limpio = String(valorFormateado).replace(/[^\d]/g, '');
  return limpio ? parseInt(limpio, 10) : 0;
}

function formatearInputMoneda(el) {
  const valor = limpiarNumero(el.value);
  el.value = valor ? money(valor) : '';
}

function dato(etiqueta, valor) {
  return '<div><span>' + esc(etiqueta) + '</span>' + (esc(valor) || '—') + '</div>';
}

/** Genera los controles "‹ Página X de Y (total Z) ›" dentro de un contenedor. */
function renderPaginacion(contenedorId, info, onCambiarPagina) {
  const cont = document.getElementById(contenedorId);
  if (!info || info.total === 0) { cont.innerHTML = ''; return; }
  cont.innerHTML =
    '<button class="btn chico secundario" ' + (info.pagina <= 1 ? 'disabled' : '') + ' id="' + contenedorId + '_prev">‹ Anterior</button>' +
    '<span class="muted">Página ' + info.pagina + ' de ' + info.totalPaginas + ' · ' + info.total + ' en total</span>' +
    '<button class="btn chico secundario" ' + (info.pagina >= info.totalPaginas ? 'disabled' : '') + ' id="' + contenedorId + '_next">Siguiente ›</button>';
  const btnPrev = document.getElementById(contenedorId + '_prev');
  const btnNext = document.getElementById(contenedorId + '_next');
  if (btnPrev) btnPrev.addEventListener('click', () => onCambiarPagina(info.pagina - 1));
  if (btnNext) btnNext.addEventListener('click', () => onCambiarPagina(info.pagina + 1));
}

// -------------------------------------------------------------------
// CLIENTES — lista paginada con filtros
// -------------------------------------------------------------------

// Reconstruye las opciones de estos selects (ciudad/ruta/cobrador cambian con los datos), pero
// conservando el valor que el usuario ya tenía elegido — si no, cada refresco (al cambiar de
// página, crear un cliente, etc.) los devolvía a "Todas/Todos" y el filtro se perdía solo.
async function cargarSelectsFiltroClientes() {
  const ciudades = await logic.listarCiudadesUsadas();
  const selCiudad = document.getElementById('cl_ciudad');
  const valorPrevioCiudad = selCiudad.value;
  selCiudad.innerHTML = '<option value="">Todas</option>' + ciudades.map((c) => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('');
  selCiudad.value = valorPrevioCiudad;

  const selRuta = document.getElementById('cl_ruta');
  const valorPrevioRuta = selRuta.value;
  selRuta.innerHTML = '<option value="">Todas</option>' + rutasCache.map((r) => '<option value="' + r.id + '">' + esc(r.Nombre) + '</option>').join('');
  selRuta.value = valorPrevioRuta;

  const selCobrador = document.getElementById('cl_cobrador');
  const valorPrevioCobrador = selCobrador.value;
  selCobrador.innerHTML = '<option value="">Todos</option>' + cobradoresCache.map((c) => '<option value="' + c.id + '">' + esc(c.Nombre) + '</option>').join('');
  selCobrador.value = valorPrevioCobrador;
}

function onFiltroClientesChange() {
  filtrosClientes.pagina = 1;
  refrescarListaClientes();
}

async function refrescarListaClientes() {
  await cargarSelectsFiltroClientes();

  filtrosClientes.query = document.getElementById('cl_buscar').value;
  filtrosClientes.ciudad = document.getElementById('cl_ciudad').value;
  filtrosClientes.tamano = Number(document.getElementById('cl_tamano').value) || 20;

  if (restriccionCobrador) {
    // Un cobrador solo puede ver los clientes de sus propias rutas: se ignora cualquier
    // filtro de ruta/cobrador que pudiera quedar en el DOM (esos controles están ocultos).
    filtrosClientes.idRuta = '';
    filtrosClientes.idCobrador = restriccionCobrador.id;
  } else {
    filtrosClientes.idRuta = document.getElementById('cl_ruta').value;
    filtrosClientes.idCobrador = document.getElementById('cl_cobrador').value;
  }

  const resultado = await logic.listarClientesPaginado(filtrosClientes);
  renderListaClientes(resultado);
  renderPaginacion('cl_paginacion', resultado, cambiarPaginaClientes);
}

function cambiarPaginaClientes(nuevaPagina) {
  filtrosClientes.pagina = nuevaPagina;
  refrescarListaClientes();
}

function renderListaClientes(resultado) {
  const cont = document.getElementById('cl_listaContenido');
  if (!resultado.items.length) { cont.innerHTML = '<p class="muted">No se encontraron clientes con estos filtros.</p>'; return; }
  cont.innerHTML = resultado.items.map((c) => {
    const nombre = c.Nombres + ' ' + (c.Apellidos || '');
    const ubicacion = (c.Ciudad ? esc(c.Ciudad) : '') + (c.ID_Ruta ? (c.Ciudad ? ' · ' : '') + 'Ruta: ' + esc(nombreRuta(c.ID_Ruta)) : '');
    return '<div class="resultado-item" onclick="mostrarDetalleCliente(\'' + c.id + '\')">' +
      '<div class="ri-avatar">' + iniciales(nombre) + '</div>' +
      '<div class="ri-body">' +
        '<div class="ri-top"><strong>' + esc(nombre) + '</strong></div>' +
        '<small>Cédula: ' + esc(c.Cedula) + (c.Celular ? ' · Cel: ' + esc(c.Celular) : '') + '</small>' +
        (ubicacion ? '<small>' + ubicacion + '</small>' : '') +
      '</div>' +
      '<span class="ri-chevron">›</span></div>';
  }).join('');
}

// -------------------------------------------------------------------
// NUEVO CLIENTE
// -------------------------------------------------------------------

async function mostrarFormNuevoCliente() {
  document.getElementById('formNuevoCliente').reset();
  document.getElementById('nuevoClienteMsg').innerHTML = '';

  if (restriccionCobrador) {
    // Se limita a sus propias rutas y se quita "Sin ruta asignada": si el cliente quedara
    // sin ruta (o en una que no es suya), el cobrador no volvería a verlo en su lista.
    const rutasPropias = rutasCache.filter((r) => rutasIdsCobradorActual.includes(r.id));
    document.getElementById('nc_ruta').innerHTML = rutasPropias.map((r) => '<option value="' + r.id + '">' + esc(r.Nombre) + '</option>').join('');
    if (!rutasPropias.length) {
      mostrarMsg('nuevoClienteMsg', 'Tu cuenta no tiene ninguna ruta asignada — pídele al dueño que te asigne una antes de registrar clientes.', 'error');
    }
  } else {
    document.getElementById('nc_ruta').innerHTML = '<option value="">Sin ruta asignada</option>' +
      rutasCache.map((r) => '<option value="' + r.id + '">' + esc(r.Nombre) + '</option>').join('');
  }
  mostrarVista('nuevoCliente');
}

function usarUbicacion() {
  if (!navigator.geolocation) { alert('Tu navegador no soporta geolocalización.'); return; }
  navigator.geolocation.getCurrentPosition((pos) => {
    document.getElementById('nc_geo').value = pos.coords.latitude.toFixed(6) + ', ' + pos.coords.longitude.toFixed(6);
  }, (err) => { alert('No se pudo obtener la ubicación: ' + err.message); });
}

async function submitNuevoCliente(ev) {
  ev.preventDefault();
  const datos = {
    Cedula: document.getElementById('nc_cedula').value.trim(),
    Nombres: document.getElementById('nc_nombres').value.trim(),
    Apellidos: document.getElementById('nc_apellidos').value.trim(),
    Celular: document.getElementById('nc_celular').value.trim(),
    Direccion: document.getElementById('nc_direccion').value.trim(),
    Ciudad: document.getElementById('nc_ciudad').value.trim(),
    ID_Ruta: document.getElementById('nc_ruta').value || null,
    Geolocalizacion: document.getElementById('nc_geo').value.trim(),
    Ocupacion: document.getElementById('nc_ocupacion').value.trim(),
    Punto_Referencia: document.getElementById('nc_referencia').value.trim(),
    Nota: document.getElementById('nc_nota').value.trim()
  };
  setCargando('btnGuardarCliente', true, 'Guardar cliente');
  try {
    const cliente = await logic.crearCliente(datos);
    intentarSincronizar();
    // Al crear el cliente, se navega directo a su detalle (para poder registrarle un préstamo).
    await mostrarDetalleCliente(cliente.id);
  } catch (e) { manejarError(e, 'nuevoClienteMsg'); }
  setCargando('btnGuardarCliente', false, 'Guardar cliente');
  return false;
}

// -------------------------------------------------------------------
// DETALLE DE CLIENTE
// -------------------------------------------------------------------

async function mostrarDetalleCliente(idCliente) {
  clienteActualId = idCliente;
  filtrosPrestamos = { pagina: 1, tamano: 10, estado: '' };
  document.getElementById('dp_filtroEstado').value = '';
  mostrarVista('detalleCliente');

  clienteActual = await logic.obtenerCliente(idCliente);
  if (!clienteActual || (restriccionCobrador && !rutasIdsCobradorActual.includes(clienteActual.ID_Ruta))) {
    mostrarVista('lista');
    return;
  }
  renderInfoCliente(clienteActual);
  await refrescarListaPrestamosCliente();
}

function renderInfoCliente(c) {
  const mapaLink = c.Geolocalizacion
    ? '<a class="link" target="_blank" href="https://www.google.com/maps?q=' + encodeURIComponent(c.Geolocalizacion) + '">Ver en Google Maps</a>'
    : '';
  const rutasParaSelect = restriccionCobrador ? rutasCache.filter((r) => rutasIdsCobradorActual.includes(r.id)) : rutasCache;
  const opcionesRuta = (restriccionCobrador ? '' : '<option value="">Sin ruta asignada</option>') +
    rutasParaSelect.map((r) => '<option value="' + r.id + '"' + (r.id === c.ID_Ruta ? ' selected' : '') + '>' + esc(r.Nombre) + '</option>').join('');

  document.getElementById('dc_infoCliente').innerHTML =
    '<div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:12px;">' +
      '<h2 style="margin:0;">' + esc(c.Nombres + ' ' + (c.Apellidos || '')) + '</h2>' +
      '<button type="button" class="btn chico secundario" onclick="mostrarModalEditarCliente()">✏️ Editar</button>' +
    '</div>' +
    '<div class="datos-grid">' +
      dato('Cédula', c.Cedula) + dato('Celular', c.Celular) + dato('Ciudad', c.Ciudad) +
      dato('Dirección', c.Direccion) + dato('Ocupación', c.Ocupacion) + dato('Punto de referencia', c.Punto_Referencia) +
    '</div>' +
    (c.Nota ? '<p class="muted" style="margin-top:8px;"><strong>Nota:</strong> ' + esc(c.Nota) + '</p>' : '') +
    (mapaLink ? '<p style="margin-top:6px;">' + mapaLink + '</p>' : '') +
    '<div class="row" style="margin-top:10px; align-items:flex-end;">' +
      '<div class="field" style="max-width:260px;"><label>Ruta</label><select id="dc_rutaSelect">' + opcionesRuta + '</select></div>' +
      '<div class="field" style="flex:0 0 auto;"><button type="button" class="btn chico secundario" onclick="guardarRutaCliente()">Guardar ruta</button></div>' +
    '</div>';
}

function mostrarModalEditarCliente() {
  if (!clienteActual) return;
  const c = clienteActual;
  const rutasParaSelect = restriccionCobrador ? rutasCache.filter((r) => rutasIdsCobradorActual.includes(r.id)) : rutasCache;
  const opcionesRuta = (restriccionCobrador ? '' : '<option value="">Sin ruta asignada</option>') +
    rutasParaSelect.map((r) => '<option value="' + r.id + '"' + (r.id === c.ID_Ruta ? ' selected' : '') + '>' + esc(r.Nombre) + '</option>').join('');

  const cuerpo =
    '<div class="row">' +
      '<div class="field"><label>Cédula *</label><input type="text" id="ec_cedula" value="' + esc(c.Cedula) + '" required></div>' +
      '<div class="field"><label>Celular</label><input type="text" id="ec_celular" value="' + esc(c.Celular) + '"></div>' +
    '</div>' +
    '<div class="row">' +
      '<div class="field"><label>Nombres *</label><input type="text" id="ec_nombres" value="' + esc(c.Nombres) + '" required></div>' +
      '<div class="field"><label>Apellidos</label><input type="text" id="ec_apellidos" value="' + esc(c.Apellidos) + '"></div>' +
    '</div>' +
    '<div class="row">' +
      '<div class="field"><label>Dirección</label><input type="text" id="ec_direccion" value="' + esc(c.Direccion) + '"></div>' +
      '<div class="field"><label>Ciudad</label><input type="text" id="ec_ciudad" value="' + esc(c.Ciudad) + '"></div>' +
    '</div>' +
    '<div class="row">' +
      '<div class="field"><label>Ruta</label><select id="ec_ruta">' + opcionesRuta + '</select></div>' +
      '<div class="field"><label>Geolocalización (lat, lng)</label><input type="text" id="ec_geo" value="' + esc(c.Geolocalizacion) + '"></div>' +
    '</div>' +
    '<div class="row">' +
      '<div class="field"><label>Ocupación</label><input type="text" id="ec_ocupacion" value="' + esc(c.Ocupacion) + '"></div>' +
      '<div class="field"><label>Punto de referencia</label><input type="text" id="ec_referencia" value="' + esc(c.Punto_Referencia) + '"></div>' +
    '</div>' +
    '<div class="field"><label>Nota</label><textarea id="ec_nota">' + esc(c.Nota) + '</textarea></div>';

  abrirModal('Editar cliente', cuerpo, guardarEdicionCliente, 'Guardar cambios');
}

async function guardarEdicionCliente() {
  const cedula = document.getElementById('ec_cedula').value.trim();
  const nombres = document.getElementById('ec_nombres').value.trim();
  if (!cedula || !nombres) { mostrarMsg('modalMsg', '⚠️ La cédula y el nombre son obligatorios.', 'error'); return; }

  const datos = {
    Cedula: cedula,
    Celular: document.getElementById('ec_celular').value.trim(),
    Nombres: nombres,
    Apellidos: document.getElementById('ec_apellidos').value.trim(),
    Direccion: document.getElementById('ec_direccion').value.trim(),
    Ciudad: document.getElementById('ec_ciudad').value.trim(),
    ID_Ruta: document.getElementById('ec_ruta').value || null,
    Geolocalizacion: document.getElementById('ec_geo').value.trim(),
    Ocupacion: document.getElementById('ec_ocupacion').value.trim(),
    Punto_Referencia: document.getElementById('ec_referencia').value.trim(),
    Nota: document.getElementById('ec_nota').value.trim()
  };
  try {
    clienteActual = await logic.actualizarCliente(clienteActualId, datos);
    cerrarModal();
    renderInfoCliente(clienteActual);
    await refrescarListaClientes();
    intentarSincronizar();
  } catch (e) { manejarError(e, 'modalMsg'); }
}

async function guardarRutaCliente() {
  const idRuta = document.getElementById('dc_rutaSelect').value || null;
  try {
    clienteActual = await logic.actualizarCliente(clienteActualId, { ID_Ruta: idRuta });
    intentarSincronizar();
  } catch (e) { manejarError(e, 'dc_infoCliente'); }
}

function onFiltroPrestamosChange() {
  filtrosPrestamos.pagina = 1;
  refrescarListaPrestamosCliente();
}

async function refrescarListaPrestamosCliente() {
  filtrosPrestamos.estado = document.getElementById('dp_filtroEstado').value;
  const resultado = await logic.listarPrestamosPorClientePaginado(clienteActualId, filtrosPrestamos);
  renderListaPrestamosCliente(resultado);
  renderPaginacion('dc_paginacion', resultado, cambiarPaginaPrestamos);
}

function cambiarPaginaPrestamos(nuevaPagina) {
  filtrosPrestamos.pagina = nuevaPagina;
  refrescarListaPrestamosCliente();
}

function renderListaPrestamosCliente(resultado) {
  const cont = document.getElementById('dc_listaPrestamos');
  if (!resultado.items.length) { cont.innerHTML = '<p class="muted">Este cliente no tiene préstamos con este filtro.</p>'; return; }
  cont.innerHTML = resultado.items.map((p) =>
    '<div class="resultado-item" onclick="mostrarDetallePrestamo(\'' + p.id + '\')">' +
    '<div class="ri-body">' +
      '<div class="ri-top"><strong>' + p.id + ' · ' + p.Fecha_Prestamo + '</strong>' +
      '<span class="badge ' + p.Estado + '">' + p.Estado + '</span></div>' +
      '<small>Monto a pagar: ' + money(p.Monto_A_Pagar) + ' · Saldo: ' + money(p.Saldo_Pendiente) + '</small>' +
    '</div>' +
    '<span class="ri-chevron">›</span></div>'
  ).join('');
}

// -------------------------------------------------------------------
// NUEVO PRESTAMO (para el cliente actual)
// -------------------------------------------------------------------

function mostrarFormNuevoPrestamo() {
  document.getElementById('formNuevoPrestamo').reset();
  document.getElementById('nuevoPrestamoMsg').innerHTML = '';
  document.getElementById('np_nombreCliente').textContent = clienteActual ? (clienteActual.Nombres + ' ' + (clienteActual.Apellidos || '')) : '';
  document.getElementById('np_fecha').value = logic.hoyISO();
  document.getElementById('np_pSeguro').value = CONFIG.seguro;
  document.getElementById('np_pInteres').value = CONFIG.interes;
  document.getElementById('np_valorSeguro').value = '';
  document.getElementById('np_montoEntregado').value = '';
  document.getElementById('np_valorInteres').value = '';
  document.getElementById('np_montoAPagar').value = '';
  document.getElementById('np_numCuotas').value = 1;
  actualizarDisponibilidadFrecuencia();
  renderPlanPagos();
  mostrarVista('nuevoPrestamo');
}

function onMontoPrestadoInput() {
  formatearInputMoneda(document.getElementById('np_monto'));
  recalcularPrestamo('monto');
}

function onMontoAPagarInput() {
  formatearInputMoneda(document.getElementById('np_montoAPagar'));
  recalcularPrestamo('montoAPagar');
}

// El usuario puede editar directamente el valor del seguro, el monto entregado o el valor del
// interés; cada uno recalcula hacia atrás su pareja (y, en el caso del interés, el monto a pagar
// y por lo tanto el plan de pagos).
function onValorSeguroInput() {
  formatearInputMoneda(document.getElementById('np_valorSeguro'));
  const monto = limpiarNumero(document.getElementById('np_monto').value);
  const valorSeguro = limpiarNumero(document.getElementById('np_valorSeguro').value);
  document.getElementById('np_pSeguro').value = monto > 0 ? round1((valorSeguro / monto) * 100) : 0;
  document.getElementById('np_montoEntregado').value = money(monto - valorSeguro);
}

function onMontoEntregadoInput() {
  formatearInputMoneda(document.getElementById('np_montoEntregado'));
  const monto = limpiarNumero(document.getElementById('np_monto').value);
  const montoEntregado = limpiarNumero(document.getElementById('np_montoEntregado').value);
  const valorSeguro = monto - montoEntregado;
  document.getElementById('np_valorSeguro').value = money(valorSeguro);
  document.getElementById('np_pSeguro').value = monto > 0 ? round1((valorSeguro / monto) * 100) : 0;
}

function onValorInteresInput() {
  formatearInputMoneda(document.getElementById('np_valorInteres'));
  const monto = limpiarNumero(document.getElementById('np_monto').value);
  const valorInteres = limpiarNumero(document.getElementById('np_valorInteres').value);
  document.getElementById('np_pInteres').value = monto > 0 ? round1((valorInteres / monto) * 100) : 0;
  document.getElementById('np_montoAPagar').value = money(monto + valorInteres);
  renderPlanPagos();
}

function recalcularPrestamo(origen) {
  const monto = limpiarNumero(document.getElementById('np_monto').value);
  const pSeguro = Number(document.getElementById('np_pSeguro').value) || 0;
  const pInteres = Number(document.getElementById('np_pInteres').value) || 0;

  if (origen === 'montoAPagar') {
    const montoAPagarManual = limpiarNumero(document.getElementById('np_montoAPagar').value);
    const valorInteres = montoAPagarManual - monto;
    const pInteresCalc = monto > 0 ? (valorInteres / monto) * 100 : 0;
    document.getElementById('np_pInteres').value = round1(pInteresCalc);
    document.getElementById('np_valorInteres').value = money(valorInteres);
    const valorSeguro = monto * (pSeguro / 100);
    document.getElementById('np_valorSeguro').value = money(valorSeguro);
    document.getElementById('np_montoEntregado').value = money(monto - valorSeguro);
    renderPlanPagos();
    return;
  }

  if (!monto) {
    document.getElementById('np_valorSeguro').value = '';
    document.getElementById('np_montoEntregado').value = '';
    document.getElementById('np_valorInteres').value = '';
    document.getElementById('np_montoAPagar').value = '';
    renderPlanPagos();
    return;
  }

  const valorSeguro2 = monto * (pSeguro / 100);
  const valorInteres2 = monto * (pInteres / 100);
  const montoAPagarSugerido = monto + valorInteres2;

  document.getElementById('np_valorSeguro').value = money(valorSeguro2);
  document.getElementById('np_montoEntregado').value = money(monto - valorSeguro2);
  document.getElementById('np_valorInteres').value = money(valorInteres2);
  document.getElementById('np_montoAPagar').value = money(montoAPagarSugerido);
  renderPlanPagos();
}

// -------------------------------------------------------------------
// PLAN DE PAGOS (cuotas del nuevo préstamo)
// -------------------------------------------------------------------

// Suma meses a una fecha "recortando" al último día del mes destino cuando hace falta
// (ej: 31 de enero + 1 mes -> 28/29 de febrero, no "rebota" a marzo como con setMonth() directo).
function sumarMesesClamp(d, meses) {
  const diaOriginal = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + meses);
  const ultimoDiaDelMes = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(diaOriginal, ultimoDiaDelMes));
}

// Suma "factor" intervalos de la frecuencia indicada a una fecha ISO (YYYY-MM-DD),
// calculando en fecha local para no correr el día por husos horarios.
function sumarIntervaloFrecuencia(fechaISO, frecuencia, factor) {
  const partes = String(fechaISO || '').split('-');
  const d = (partes.length === 3)
    ? new Date(parseInt(partes[0], 10), parseInt(partes[1], 10) - 1, parseInt(partes[2], 10))
    : new Date();
  switch (frecuencia) {
    case 'Diario': d.setDate(d.getDate() + 1 * factor); break;
    case 'Semanal': d.setDate(d.getDate() + 7 * factor); break;
    case 'Quincenal': d.setDate(d.getDate() + 15 * factor); break;
    case 'Mensual': sumarMesesClamp(d, 1 * factor); break;
    default: sumarMesesClamp(d, 1 * factor); // "Único pago" u otra: se toma 1 mes como referencia
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + dia;
}

function onPlanPagosParamsChange() {
  actualizarDisponibilidadFrecuencia();
  renderPlanPagos();
}

// "Único pago" solo tiene sentido con 1 cuota; con más de una se deshabilita esa opción
// y, si estaba seleccionada, se cambia a una frecuencia real por defecto.
function actualizarDisponibilidadFrecuencia() {
  const numCuotas = Math.max(1, parseInt(document.getElementById('np_numCuotas').value, 10) || 1);
  const opcionUnico = document.getElementById('np_opcionUnicoPago');
  const selectFrecuencia = document.getElementById('np_frecuencia');
  if (!opcionUnico || !selectFrecuencia) return;
  if (numCuotas > 1) {
    opcionUnico.disabled = true;
    if (selectFrecuencia.value === 'Único pago') selectFrecuencia.value = 'Semanal';
  } else {
    opcionUnico.disabled = false;
  }
}

// Redibuja las cuotas del plan de pagos: valor sugerido = monto a pagar / número de cuotas
// (la última cuota absorbe el redondeo para que la suma cuadre exacto), fecha sugerida según
// la frecuencia elegida a partir de la fecha del préstamo. Todo queda editable después.
function renderPlanPagos() {
  const cont = document.getElementById('np_planPagos');
  if (!cont) return;
  const numCuotas = Math.max(1, Math.min(60, parseInt(document.getElementById('np_numCuotas').value, 10) || 1));
  const frecuencia = document.getElementById('np_frecuencia').value;
  const fechaBase = document.getElementById('np_fecha').value || logic.hoyISO();
  const montoAPagar = limpiarNumero(document.getElementById('np_montoAPagar').value);

  const valorBase = Math.round(montoAPagar / numCuotas);
  let html = '';
  for (let i = 0; i < numCuotas; i++) {
    const fecha = sumarIntervaloFrecuencia(fechaBase, frecuencia, i + 1);
    const valorCuota = (i === numCuotas - 1) ? (montoAPagar - valorBase * (numCuotas - 1)) : valorBase;
    html += '<div class="row plan-cuota-fila" style="align-items:flex-end;">' +
      '<div class="field" style="flex:0 0 64px;"><label>Cuota</label><input type="text" value="' + (i + 1) + '" readonly></div>' +
      '<div class="field"><label>Fecha de pago</label><input type="date" class="pc-fecha" value="' + fecha + '" required></div>' +
      '<div class="field"><label>Valor de la cuota</label><input type="text" inputmode="numeric" class="pc-valor" value="' + money(valorCuota) + '" oninput="formatearInputMoneda(this); actualizarTotalPlanPagos()" required></div>' +
    '</div>';
  }
  cont.innerHTML = html;
  actualizarTotalPlanPagos();
}

function actualizarTotalPlanPagos() {
  const el = document.getElementById('np_planPagosTotal');
  if (!el) return;
  const valores = Array.from(document.querySelectorAll('#np_planPagos .pc-valor')).map((input) => limpiarNumero(input.value));
  const total = valores.reduce((a, b) => a + b, 0);
  const montoAPagar = limpiarNumero(document.getElementById('np_montoAPagar').value);
  const diff = round2(total - montoAPagar);
  if (Math.abs(diff) < 1) {
    el.innerHTML = 'Total del plan: <strong>' + money(total) + '</strong> — coincide con el monto a pagar.';
  } else {
    el.innerHTML = 'Total del plan: <strong>' + money(total) + '</strong> — ' + (diff > 0 ? 'excede' : 'falta') +
      ' ' + money(Math.abs(diff)) + ' frente al monto a pagar (' + money(montoAPagar) + ').';
  }
}

async function submitNuevoPrestamo(ev) {
  ev.preventDefault();
  if (!clienteActualId) { mostrarMsg('nuevoPrestamoMsg', '⚠️ No hay un cliente seleccionado.', 'error'); return false; }

  const filasCuota = document.querySelectorAll('#np_planPagos .plan-cuota-fila');
  if (!filasCuota.length) { mostrarMsg('nuevoPrestamoMsg', '⚠️ Debes indicar al menos una cuota en el plan de pagos.', 'error'); return false; }
  const planPagos = [];
  for (let i = 0; i < filasCuota.length; i++) {
    const fecha = filasCuota[i].querySelector('.pc-fecha').value;
    const valor = limpiarNumero(filasCuota[i].querySelector('.pc-valor').value);
    if (!fecha) { mostrarMsg('nuevoPrestamoMsg', '⚠️ Falta la fecha de la cuota ' + (i + 1) + ' del plan de pagos.', 'error'); return false; }
    if (!valor || valor <= 0) { mostrarMsg('nuevoPrestamoMsg', '⚠️ El valor de la cuota ' + (i + 1) + ' debe ser mayor a cero.', 'error'); return false; }
    planPagos.push({ numero: i + 1, fecha, valor });
  }

  const datos = {
    ID_Cliente: clienteActualId,
    Fecha_Prestamo: document.getElementById('np_fecha').value,
    Monto_Prestado: limpiarNumero(document.getElementById('np_monto').value),
    Porcentaje_Seguro: document.getElementById('np_pSeguro').value,
    Porcentaje_Interes: document.getElementById('np_pInteres').value,
    Monto_A_Pagar: limpiarNumero(document.getElementById('np_montoAPagar').value),
    Fecha_Pago: planPagos[planPagos.length - 1].fecha,
    Frecuencia_Pago: document.getElementById('np_frecuencia').value,
    Plan_Pagos: planPagos,
    Nota: document.getElementById('np_nota').value
  };

  setCargando('btnGuardarPrestamo', true, 'Guardar préstamo');
  try {
    const prestamo = await logic.crearPrestamo(datos);
    intentarSincronizar();
    // Al crear el préstamo, se navega directo a su detalle para poder registrar abonos.
    await mostrarDetallePrestamo(prestamo.id);
  } catch (e) { manejarError(e, 'nuevoPrestamoMsg'); }
  setCargando('btnGuardarPrestamo', false, 'Guardar préstamo');
  return false;
}

// -------------------------------------------------------------------
// DETALLE DE PRESTAMO — abonos, retanqueo e historial
// -------------------------------------------------------------------

async function mostrarDetallePrestamo(idPrestamo) {
  prestamoActualId = idPrestamo;
  mostrarVista('detallePrestamo');

  document.getElementById('abonoMsg').innerHTML = '';
  document.getElementById('retanqueoMsg').innerHTML = '';
  document.getElementById('formAbono').reset();
  document.getElementById('formRetanqueo').reset();
  document.getElementById('ab_fecha').value = logic.hoyISO();
  document.getElementById('rq_fecha').value = logic.hoyISO();
  document.getElementById('rq_fechaPago').value = '';
  document.getElementById('rq_pSeguro').value = CONFIG.seguro;
  document.getElementById('rq_pInteres').value = CONFIG.interes;
  document.getElementById('rq_valorSeguro').value = '';
  document.getElementById('rq_valorInteres').value = '';
  document.getElementById('rq_montoAPagar').value = '';

  await refrescarDetallePrestamo();
}

async function refrescarDetallePrestamo() {
  prestamoActual = await logic.obtenerPrestamo(prestamoActualId);
  if (!prestamoActual) { mostrarVista('lista'); return; }

  renderResumenPrestamo(prestamoActual);
  renderHistorialPrestamo(prestamoActual);

  const puedeAbonar = prestamoActual.Estado !== 'Pagado' && prestamoActual.Estado !== 'Cancelado';
  document.getElementById('abonoCard').style.display = puedeAbonar ? '' : 'none';
  document.getElementById('rq_card').style.display = prestamoActual.Estado !== 'Cancelado' ? '' : 'none';
}

function renderResumenPrestamo(p) {
  const puedeMarcarPagada = p.Estado !== 'Pagado' && p.Estado !== 'Cancelado';
  const planHtml = (p.Plan_Pagos && p.Plan_Pagos.length >= 1)
    ? '<div style="margin-top:10px;">' +
        '<h3 style="font-size:13px; margin:0 0 6px;">Plan de pagos (' + p.Plan_Pagos.length + ' cuotas)</h3>' +
        '<div class="abonos-lista">' + p.Plan_Pagos.map((c) =>
          '<div class="abono-row cuota-row">' +
            '<span>Cuota ' + c.numero + ' · ' + c.fecha + (c.pagada && c.fechaPagoReal ? ' · pagada ' + c.fechaPagoReal : '') + '</span>' +
            '<span class="cuota-accion">' +
              '<strong>' + money(c.valor) + '</strong>' +
              (c.pagada
                ? '<span class="badge Pagado">Pagada</span><button type="button" class="btn chico secundario" onclick="onRevertirCuotaPagada(' + c.numero + ')">Revertir</button>'
                : (puedeMarcarPagada ? '<button type="button" class="btn chico secundario" onclick="onMarcarCuotaPagada(' + c.numero + ')">Marcar pagada</button>' : '')) +
            '</span>' +
          '</div>'
        ).join('') + '</div>' +
      '</div>'
    : '';

  document.getElementById('dp_resumen').innerHTML =
    '<div class="prestamo-head"><strong>' + p.id + ' · ' + p.Fecha_Prestamo + '</strong>' +
    '<span style="display:flex; align-items:center; gap:8px;">' +
      '<span class="badge ' + p.Estado + '">' + p.Estado + '</span>' +
      '<button type="button" class="btn chico secundario" onclick="mostrarModalEditarPrestamo()">✏️ Editar</button>' +
    '</span></div>' +
    '<div class="datos-grid">' +
      dato('Monto prestado', money(p.Monto_Prestado)) +
      dato('Seguro (' + round1(p.Porcentaje_Seguro) + '%)', money(p.Valor_Seguro)) +
      dato('Entregado', money(p.Monto_Entregado)) +
      dato('Interés (' + round1(p.Porcentaje_Interes) + '%)', money(p.Valor_Interes)) +
      dato('Monto a pagar', money(p.Monto_A_Pagar)) +
      dato('Fecha de pago', p.Fecha_Pago) +
      dato('Frecuencia', p.Frecuencia_Pago) +
      dato('Total abonado', money(p.Total_Abonado)) +
      dato('Saldo pendiente', money(p.Saldo_Pendiente)) +
    '</div>' + planHtml +
    (p.Nota ? '<p class="muted" style="margin-top:6px;">📝 ' + esc(p.Nota) + '</p>' : '');
}

function renderHistorialPrestamo(p) {
  let html = '';
  html += '<h3 style="font-size:13px; margin:0 0 6px;">Abonos (' + p.Abonos.length + ')</h3>';
  if (!p.Abonos.length) {
    html += '<p class="muted">Sin abonos registrados.</p>';
  } else {
    html += '<div class="abonos-lista">' + p.Abonos.map((a) =>
      '<div class="abono-row"><span>' + a.Fecha_Abono + (a.Nota ? ' — ' + esc(a.Nota) : '') + '</span><strong>' + money(a.Valor_Abono) + '</strong></div>'
    ).join('') + '</div>';
  }
  if (p.Historial_Retanqueos && p.Historial_Retanqueos.length) {
    html += '<h3 style="font-size:13px; margin:14px 0 6px;">Retanqueos (' + p.Historial_Retanqueos.length + ')</h3>';
    html += '<div class="abonos-lista">' + p.Historial_Retanqueos.map((r) =>
      '<div class="abono-row"><span>' + r.fecha + ' — de ' + r.fechaPagoAnterior + ' a ' + r.fechaPagoNueva + (r.nota ? ' — ' + esc(r.nota) : '') + '</span>' +
      '<strong>+' + money(r.montoAdicional) + ' → total ' + money(r.montoAPagarNuevo) + '</strong></div>'
    ).join('') + '</div>';
  }
  document.getElementById('dp_historial').innerHTML = html;
}

// -------------------------------------------------------------------
// EDITAR PRÉSTAMO (corrige datos de cabecera; no toca abonos ni plan de cuotas)
// -------------------------------------------------------------------

function mostrarModalEditarPrestamo() {
  if (!prestamoActual) return;
  const p = prestamoActual;
  const cuerpo =
    '<div class="row">' +
      '<div class="field"><label>Fecha del préstamo</label><input type="date" id="ep_fecha" value="' + esc(p.Fecha_Prestamo) + '"></div>' +
      '<div class="field"><label>Monto prestado *</label><input type="text" inputmode="numeric" id="ep_monto" value="' + money(p.Monto_Prestado) + '" required oninput="onEpMontoInput()"></div>' +
    '</div>' +
    '<div class="row">' +
      '<div class="field"><label>% Seguro</label><input type="number" step="0.01" id="ep_pSeguro" value="' + round1(p.Porcentaje_Seguro) + '" oninput="recalcularEditarPrestamo(\'seguro\')"></div>' +
      '<div class="field"><label>Valor del seguro</label><input type="text" inputmode="numeric" id="ep_valorSeguro" value="' + money(p.Valor_Seguro) + '" oninput="onEpValorSeguroInput()"></div>' +
    '</div>' +
    '<div class="row">' +
      '<div class="field"><label>% Interés</label><input type="number" step="0.01" id="ep_pInteres" value="' + round1(p.Porcentaje_Interes) + '" oninput="recalcularEditarPrestamo(\'interes\')"></div>' +
      '<div class="field"><label>Valor del interés</label><input type="text" inputmode="numeric" id="ep_valorInteres" value="' + money(p.Valor_Interes) + '" oninput="onEpValorInteresInput()"></div>' +
    '</div>' +
    '<div class="row">' +
      '<div class="field"><label>Monto a pagar</label><input type="text" inputmode="numeric" id="ep_montoAPagar" value="' + money(p.Monto_A_Pagar) + '" oninput="onEpMontoAPagarInput()"></div>' +
      '<div class="field"><label>Fecha de pago *</label><input type="date" id="ep_fechaPago" value="' + esc(p.Fecha_Pago) + '" required></div>' +
    '</div>' +
    '<div class="field"><label>Nota</label><textarea id="ep_nota">' + esc(p.Nota) + '</textarea></div>' +
    '<p class="muted" style="margin-top:8px;">Esto corrige los datos del préstamo (por ejemplo, un error de digitación); no cambia los abonos ya registrados ni el plan de cuotas.</p>';

  abrirModal('Editar préstamo', cuerpo, guardarEdicionPrestamo, 'Guardar cambios');
}

function onEpMontoInput() {
  formatearInputMoneda(document.getElementById('ep_monto'));
  recalcularEditarPrestamo('monto');
}

function onEpMontoAPagarInput() {
  formatearInputMoneda(document.getElementById('ep_montoAPagar'));
  recalcularEditarPrestamo('montoAPagar');
}

function onEpValorSeguroInput() {
  formatearInputMoneda(document.getElementById('ep_valorSeguro'));
  const monto = limpiarNumero(document.getElementById('ep_monto').value);
  const valorSeguro = limpiarNumero(document.getElementById('ep_valorSeguro').value);
  document.getElementById('ep_pSeguro').value = monto > 0 ? round1((valorSeguro / monto) * 100) : 0;
}

function onEpValorInteresInput() {
  formatearInputMoneda(document.getElementById('ep_valorInteres'));
  const monto = limpiarNumero(document.getElementById('ep_monto').value);
  const valorInteres = limpiarNumero(document.getElementById('ep_valorInteres').value);
  document.getElementById('ep_pInteres').value = monto > 0 ? round1((valorInteres / monto) * 100) : 0;
  document.getElementById('ep_montoAPagar').value = money(monto + valorInteres);
}

function recalcularEditarPrestamo(origen) {
  const monto = limpiarNumero(document.getElementById('ep_monto').value);
  const pSeguro = Number(document.getElementById('ep_pSeguro').value) || 0;
  const pInteres = Number(document.getElementById('ep_pInteres').value) || 0;

  if (origen === 'montoAPagar') {
    const montoAPagarManual = limpiarNumero(document.getElementById('ep_montoAPagar').value);
    const valorInteres = montoAPagarManual - monto;
    const pInteresCalc = monto > 0 ? (valorInteres / monto) * 100 : 0;
    document.getElementById('ep_pInteres').value = round1(pInteresCalc);
    document.getElementById('ep_valorInteres').value = money(valorInteres);
    const valorSeguro = monto * (pSeguro / 100);
    document.getElementById('ep_valorSeguro').value = money(valorSeguro);
    return;
  }

  if (!monto) {
    document.getElementById('ep_valorSeguro').value = '';
    document.getElementById('ep_valorInteres').value = '';
    document.getElementById('ep_montoAPagar').value = '';
    return;
  }

  const valorSeguro2 = monto * (pSeguro / 100);
  const valorInteres2 = monto * (pInteres / 100);
  document.getElementById('ep_valorSeguro').value = money(valorSeguro2);
  document.getElementById('ep_valorInteres').value = money(valorInteres2);
  document.getElementById('ep_montoAPagar').value = money(monto + valorInteres2);
}

async function guardarEdicionPrestamo() {
  const monto = limpiarNumero(document.getElementById('ep_monto').value);
  const fechaPago = document.getElementById('ep_fechaPago').value;
  if (!monto || monto <= 0) { mostrarMsg('modalMsg', '⚠️ El monto prestado debe ser mayor a cero.', 'error'); return; }
  if (!fechaPago) { mostrarMsg('modalMsg', '⚠️ La fecha de pago es obligatoria.', 'error'); return; }

  const valorSeguro = limpiarNumero(document.getElementById('ep_valorSeguro').value);
  const datos = {
    Fecha_Prestamo: document.getElementById('ep_fecha').value,
    Monto_Prestado: monto,
    Porcentaje_Seguro: Number(document.getElementById('ep_pSeguro').value) || 0,
    Valor_Seguro: valorSeguro,
    Monto_Entregado: monto - valorSeguro,
    Porcentaje_Interes: Number(document.getElementById('ep_pInteres').value) || 0,
    Valor_Interes: limpiarNumero(document.getElementById('ep_valorInteres').value),
    Monto_A_Pagar: limpiarNumero(document.getElementById('ep_montoAPagar').value),
    Fecha_Pago: fechaPago,
    Nota: document.getElementById('ep_nota').value.trim()
  };
  try {
    prestamoActual = await logic.actualizarPrestamo(prestamoActualId, datos);
    cerrarModal();
    await refrescarDetallePrestamo();
    await refrescarListaPrestamosCliente();
    intentarSincronizar();
  } catch (e) { manejarError(e, 'modalMsg'); }
}

async function submitAbono(ev) {
  ev.preventDefault();
  if (!prestamoActualId) { mostrarMsg('abonoMsg', '⚠️ No hay un préstamo seleccionado.', 'error'); return false; }
  const fecha = document.getElementById('ab_fecha').value;
  const valor = limpiarNumero(document.getElementById('ab_valor').value);
  const nota = document.getElementById('ab_nota').value;

  setCargando('btnGuardarAbono', true, 'Registrar abono');
  try {
    const prestamo = await logic.registrarAbono(prestamoActualId, fecha, valor, nota);
    mostrarMsg('abonoMsg', '✅ Abono registrado. Nuevo saldo: ' + money(prestamo.Saldo_Pendiente) + ' — Estado: ' + prestamo.Estado, 'ok');
    document.getElementById('formAbono').reset();
    document.getElementById('ab_fecha').value = logic.hoyISO();
    // La información del préstamo (saldo, estado, historial) se actualiza automáticamente.
    await refrescarDetallePrestamo();
    intentarSincronizar();
  } catch (e) { manejarError(e, 'abonoMsg'); }
  setCargando('btnGuardarAbono', false, 'Registrar abono');
  return false;
}

// Atajo desde el plan de pagos: marca una cuota como pagada y la registra de una vez como abono.
function onMarcarCuotaPagada(numeroCuota) {
  if (!prestamoActualId || !prestamoActual) return;
  const cuota = (prestamoActual.Plan_Pagos || []).find((c) => c.numero === numeroCuota);
  if (!cuota) return;

  const cuerpo =
    '<p class="muted">Cuota ' + numeroCuota + ' — vencía el ' + esc(cuota.fecha) + '.</p>' +
    '<div class="field"><label>Valor pagado *</label><input type="text" inputmode="numeric" id="modal_valorCuota" value="' + money(cuota.valor) + '" oninput="formatearInputMoneda(this)"></div>' +
    '<div class="field"><label>Fecha de pago</label><input type="date" id="modal_fechaCuota" value="' + logic.hoyISO() + '"></div>';

  abrirModal('Marcar cuota ' + numeroCuota + ' como pagada', cuerpo, async () => {
    const valor = limpiarNumero(document.getElementById('modal_valorCuota').value);
    const fecha = document.getElementById('modal_fechaCuota').value;
    if (!valor || valor <= 0) { mostrarMsg('modalMsg', '⚠️ El valor pagado debe ser mayor a cero.', 'error'); return; }
    if (!fecha) { mostrarMsg('modalMsg', '⚠️ Indica la fecha de pago.', 'error'); return; }
    try {
      const prestamo = await logic.marcarCuotaPagada(prestamoActualId, numeroCuota, fecha, valor);
      cerrarModal();
      mostrarMsg('abonoMsg', '✅ Cuota ' + numeroCuota + ' marcada como pagada. Nuevo saldo: ' + money(prestamo.Saldo_Pendiente) + ' — Estado: ' + prestamo.Estado, 'ok');
      await refrescarDetallePrestamo();
      intentarSincronizar();
    } catch (e) { manejarError(e, 'modalMsg'); }
  }, 'Marcar como pagada');
}

function onRevertirCuotaPagada(numeroCuota) {
  if (!prestamoActualId || !prestamoActual) return;
  const cuota = (prestamoActual.Plan_Pagos || []).find((c) => c.numero === numeroCuota);
  if (!cuota) return;

  const cuerpo =
    '<p>¿Confirmas que quieres revertir el pago de la cuota ' + numeroCuota + ' (' + money(cuota.valor) +
    (cuota.fechaPagoReal ? ', pagada el ' + esc(cuota.fechaPagoReal) : '') + ')?</p>' +
    '<p class="muted">Se elimina el abono que se registró para esa cuota y vuelve a quedar pendiente.</p>';

  abrirModal('Revertir pago de la cuota ' + numeroCuota, cuerpo, async () => {
    try {
      const prestamo = await logic.revertirCuotaPagada(prestamoActualId, numeroCuota);
      cerrarModal();
      mostrarMsg('abonoMsg', '↩️ Se revirtió el pago de la cuota ' + numeroCuota + '. Nuevo saldo: ' + money(prestamo.Saldo_Pendiente) + ' — Estado: ' + prestamo.Estado, 'info');
      await refrescarDetallePrestamo();
      intentarSincronizar();
    } catch (e) { manejarError(e, 'modalMsg'); }
  }, 'Revertir pago');
}

// -------------------------------------------------------------------
// RETANQUEO
// -------------------------------------------------------------------

function onMontoAdicionalInput() {
  formatearInputMoneda(document.getElementById('rq_valorAbono'));
  formatearInputMoneda(document.getElementById('rq_montoAdicional'));
  recalcularRetanqueo('monto');
}

function onMontoAPagarRetanqueoInput() {
  formatearInputMoneda(document.getElementById('rq_montoAPagar'));
  recalcularRetanqueo('montoAPagar');
}

// El usuario también puede editar directamente el valor del seguro o del interés
// adicional (no solo el porcentaje); cada uno recalcula hacia atrás su porcentaje —
// igual que en el formulario de "Nuevo préstamo".
function onRqValorSeguroInput() {
  if (!prestamoActual) return;
  formatearInputMoneda(document.getElementById('rq_valorSeguro'));
  const montoAdicional = limpiarNumero(document.getElementById('rq_montoAdicional').value);
  const valorSeguro = limpiarNumero(document.getElementById('rq_valorSeguro').value);
  document.getElementById('rq_pSeguro').value = montoAdicional > 0 ? round1((valorSeguro / montoAdicional) * 100) : 0;
}

function onRqValorInteresInput() {
  if (!prestamoActual) return;
  formatearInputMoneda(document.getElementById('rq_valorInteres'));
  const montoAdicional = limpiarNumero(document.getElementById('rq_montoAdicional').value);
  const valorInteres = limpiarNumero(document.getElementById('rq_valorInteres').value);
  document.getElementById('rq_pInteres').value = montoAdicional > 0 ? round1((valorInteres / montoAdicional) * 100) : 0;
  const valorAbono = limpiarNumero(document.getElementById('rq_valorAbono').value);
  const saldoAntes = Math.max(0, round2(prestamoActual.Saldo_Pendiente - valorAbono));
  document.getElementById('rq_montoAPagar').value = money(saldoAntes + montoAdicional + valorInteres);
}

function recalcularRetanqueo(origen) {
  if (!prestamoActual) return;
  const valorAbono = limpiarNumero(document.getElementById('rq_valorAbono').value);
  const montoAdicional = limpiarNumero(document.getElementById('rq_montoAdicional').value);
  const pSeguro = Number(document.getElementById('rq_pSeguro').value) || 0;
  const pInteres = Number(document.getElementById('rq_pInteres').value) || 0;
  const saldoAntes = Math.max(0, round2(prestamoActual.Saldo_Pendiente - valorAbono));

  if (origen === 'montoAPagar') {
    const montoAPagarManual = limpiarNumero(document.getElementById('rq_montoAPagar').value);
    const valorInteres = montoAPagarManual - saldoAntes - montoAdicional;
    const pInteresCalc = montoAdicional > 0 ? (valorInteres / montoAdicional) * 100 : 0;
    document.getElementById('rq_pInteres').value = round1(pInteresCalc);
    document.getElementById('rq_valorInteres').value = money(valorInteres);
    const valorSeguro = montoAdicional * (pSeguro / 100);
    document.getElementById('rq_valorSeguro').value = money(valorSeguro);
    return;
  }

  if (!montoAdicional) {
    document.getElementById('rq_valorSeguro').value = '';
    document.getElementById('rq_valorInteres').value = '';
    document.getElementById('rq_montoAPagar').value = '';
    return;
  }

  const valorSeguro2 = montoAdicional * (pSeguro / 100);
  const valorInteres2 = montoAdicional * (pInteres / 100);
  const montoAPagarSugerido = saldoAntes + montoAdicional + valorInteres2;

  document.getElementById('rq_valorSeguro').value = money(valorSeguro2);
  document.getElementById('rq_valorInteres').value = money(valorInteres2);
  document.getElementById('rq_montoAPagar').value = money(montoAPagarSugerido);
}

async function submitRetanqueo(ev) {
  ev.preventDefault();
  if (!prestamoActualId) { mostrarMsg('retanqueoMsg', '⚠️ No hay un préstamo seleccionado.', 'error'); return false; }

  const datos = {
    Fecha: document.getElementById('rq_fecha').value,
    ValorAbono: limpiarNumero(document.getElementById('rq_valorAbono').value),
    MontoAdicional: limpiarNumero(document.getElementById('rq_montoAdicional').value),
    Porcentaje_Seguro: document.getElementById('rq_pSeguro').value,
    Porcentaje_Interes: document.getElementById('rq_pInteres').value,
    Monto_A_Pagar_Nuevo: limpiarNumero(document.getElementById('rq_montoAPagar').value),
    Nueva_Fecha_Pago: document.getElementById('rq_fechaPago').value,
    Nota: document.getElementById('rq_nota').value
  };

  setCargando('btnGuardarRetanqueo', true, 'Retanquear préstamo');
  try {
    const prestamo = await logic.retanquearPrestamo(prestamoActualId, datos);
    mostrarMsg('retanqueoMsg', '✅ Préstamo retanqueado. Nuevo monto a pagar: ' + money(prestamo.Monto_A_Pagar) + ' — vence ' + prestamo.Fecha_Pago, 'ok');
    document.getElementById('formRetanqueo').reset();
    document.getElementById('rq_fecha').value = logic.hoyISO();
    document.getElementById('rq_pSeguro').value = CONFIG.seguro;
    document.getElementById('rq_pInteres').value = CONFIG.interes;
    await refrescarDetallePrestamo();
    intentarSincronizar();
  } catch (e) { manejarError(e, 'retanqueoMsg'); }
  setCargando('btnGuardarRetanqueo', false, 'Retanquear préstamo');
  return false;
}

// -------------------------------------------------------------------
// RUTAS
// -------------------------------------------------------------------

async function cargarSelectRutaCobrador() {
  const sel = document.getElementById('rt_cobrador');
  const valorPrevio = sel.value;
  sel.innerHTML = '<option value="">Sin cobrador asignado</option>' +
    cobradoresCache.map((c) => '<option value="' + c.id + '">' + esc(c.Nombre) + '</option>').join('');
  sel.value = valorPrevio;
}

async function refrescarRutas() {
  await recargarCaches();
  await cargarSelectRutaCobrador();
  const conteo = await logic.contarClientesPorRuta();

  const cont = document.getElementById('rt_lista');
  if (!rutasCache.length) { cont.innerHTML = '<p class="muted">Aún no has creado ninguna ruta.</p>'; return; }

  cont.innerHTML = rutasCache.map((r) => {
    const opciones = '<option value="">Sin cobrador asignado</option>' +
      cobradoresCache.map((c) => '<option value="' + c.id + '"' + (c.id === r.ID_Cobrador ? ' selected' : '') + '>' + esc(c.Nombre) + '</option>').join('');
    return '<div class="resultado-item estatico">' +
      '<div class="ri-avatar">🧭</div>' +
      '<div class="ri-body">' +
        '<div class="ri-top"><strong>' + esc(r.Nombre) + '</strong><span class="ri-count">' + (conteo[r.id] || 0) + ' cliente(s)</span></div>' +
        (r.Nota ? '<small>' + esc(r.Nota) + '</small>' : '') +
        '<div class="ri-acciones">' +
          '<select id="rt_cobradorEdit_' + r.id + '">' + opciones + '</select>' +
          '<button type="button" class="btn chico secundario" onclick="guardarCobradorDeRuta(\'' + r.id + '\')">Guardar</button>' +
          '<button type="button" class="btn chico secundario" onclick="mostrarModalEditarRuta(\'' + r.id + '\')">✏️ Editar</button>' +
        '</div>' +
      '</div></div>';
  }).join('');
}

async function guardarCobradorDeRuta(idRuta) {
  const idCobrador = document.getElementById('rt_cobradorEdit_' + idRuta).value || null;
  try {
    await logic.actualizarRuta(idRuta, { ID_Cobrador: idCobrador });
    intentarSincronizar();
    await refrescarRutas();
  } catch (e) { manejarError(e, 'rutaMsg'); }
}

function mostrarModalEditarRuta(idRuta) {
  const r = rutasCache.find((x) => x.id === idRuta);
  if (!r) return;
  const cuerpo =
    '<div class="field"><label>Nombre de la ruta *</label><input type="text" id="er_nombre" value="' + esc(r.Nombre) + '" required></div>' +
    '<div class="field"><label>Nota</label><input type="text" id="er_nota" value="' + esc(r.Nota) + '"></div>';
  abrirModal('Editar ruta', cuerpo, () => guardarEdicionRuta(idRuta), 'Guardar cambios');
}

async function guardarEdicionRuta(idRuta) {
  const nombre = document.getElementById('er_nombre').value.trim();
  if (!nombre) { mostrarMsg('modalMsg', '⚠️ El nombre de la ruta es obligatorio.', 'error'); return; }
  try {
    await logic.actualizarRuta(idRuta, { Nombre: nombre, Nota: document.getElementById('er_nota').value.trim() });
    cerrarModal();
    await refrescarRutas();
    intentarSincronizar();
  } catch (e) { manejarError(e, 'modalMsg'); }
}

async function submitNuevaRuta(ev) {
  ev.preventDefault();
  const datos = {
    Nombre: document.getElementById('rt_nombre').value.trim(),
    ID_Cobrador: document.getElementById('rt_cobrador').value || null,
    Nota: document.getElementById('rt_nota').value.trim()
  };
  setCargando('btnGuardarRuta', true, 'Guardar ruta');
  try {
    await logic.crearRuta(datos);
    mostrarMsg('rutaMsg', '✅ Ruta guardada correctamente.', 'ok');
    document.getElementById('formNuevaRuta').reset();
    intentarSincronizar();
    await refrescarRutas();
  } catch (e) { manejarError(e, 'rutaMsg'); }
  setCargando('btnGuardarRuta', false, 'Guardar ruta');
  return false;
}

// -------------------------------------------------------------------
// COBRADORES
// -------------------------------------------------------------------

async function refrescarCobradores() {
  await recargarCaches();
  const cont = document.getElementById('cb_lista');
  if (!cobradoresCache.length) { cont.innerHTML = '<p class="muted">Aún no has creado ningún cobrador.</p>'; return; }

  cont.innerHTML = cobradoresCache.map((c) => {
    const rutas = rutasCache.filter((r) => r.ID_Cobrador === c.id).map((r) => r.Nombre);
    return '<div class="resultado-item estatico">' +
      '<div class="ri-avatar">' + iniciales(c.Nombre) + '</div>' +
      '<div class="ri-body">' +
        '<div class="ri-top"><strong>' + esc(c.Nombre) + '</strong>' +
        '<span class="badge ' + (c.Activo ? 'Activo' : 'Cancelado') + '">' + (c.Activo ? 'Activo' : 'Inactivo') + '</span></div>' +
        '<small>' + esc(c.Email) + (c.Telefono ? ' · ' + esc(c.Telefono) : '') + '</small>' +
        '<small>Rutas: ' + (rutas.length ? esc(rutas.join(', ')) : '—') + '</small>' +
        '<div class="ri-acciones">' +
          '<button type="button" class="btn chico secundario" onclick="alternarActivoCobrador(\'' + c.id + '\', ' + (!c.Activo) + ')">' + (c.Activo ? 'Desactivar' : 'Activar') + '</button>' +
          '<button type="button" class="btn chico secundario" onclick="mostrarModalEditarCobrador(\'' + c.id + '\')">✏️ Editar</button>' +
        '</div>' +
      '</div></div>';
  }).join('');
}

async function alternarActivoCobrador(idCobrador, nuevoValor) {
  try {
    await logic.actualizarCobrador(idCobrador, { Activo: nuevoValor });
    intentarSincronizar();
    await refrescarCobradores();
  } catch (e) { manejarError(e, 'cobradorMsg'); }
}

function mostrarModalEditarCobrador(idCobrador) {
  const c = cobradoresCache.find((x) => x.id === idCobrador);
  if (!c) return;
  const cuerpo =
    '<div class="field"><label>Nombre *</label><input type="text" id="ecb_nombre" value="' + esc(c.Nombre) + '" required></div>' +
    '<div class="field"><label>Correo de Google *</label><input type="email" id="ecb_email" value="' + esc(c.Email) + '" required></div>' +
    '<div class="field"><label>Teléfono</label><input type="text" id="ecb_telefono" value="' + esc(c.Telefono) + '"></div>';
  abrirModal('Editar cobrador', cuerpo, () => guardarEdicionCobrador(idCobrador), 'Guardar cambios');
}

async function guardarEdicionCobrador(idCobrador) {
  const nombre = document.getElementById('ecb_nombre').value.trim();
  const email = document.getElementById('ecb_email').value.trim();
  if (!nombre || !email) { mostrarMsg('modalMsg', '⚠️ El nombre y el correo son obligatorios.', 'error'); return; }
  try {
    await logic.actualizarCobrador(idCobrador, { Nombre: nombre, Email: email, Telefono: document.getElementById('ecb_telefono').value.trim() });
    cerrarModal();
    await refrescarCobradores();
    intentarSincronizar();
  } catch (e) { manejarError(e, 'modalMsg'); }
}

async function submitNuevoCobrador(ev) {
  ev.preventDefault();
  const datos = {
    Nombre: document.getElementById('cb_nombre').value.trim(),
    Email: document.getElementById('cb_email').value.trim(),
    Telefono: document.getElementById('cb_telefono').value.trim()
  };
  setCargando('btnGuardarCobrador', true, 'Guardar cobrador');
  try {
    await logic.crearCobrador(datos);
    mostrarMsg('cobradorMsg', '✅ Cobrador guardado correctamente.', 'ok');
    document.getElementById('formNuevoCobrador').reset();
    intentarSincronizar();
    await refrescarCobradores();
  } catch (e) { manejarError(e, 'cobradorMsg'); }
  setCargando('btnGuardarCobrador', false, 'Guardar cobrador');
  return false;
}

// -------------------------------------------------------------------
// DASHBOARD
// -------------------------------------------------------------------

async function cargarSelectsDashboard() {
  const clientes = await logic.listarClientes();
  const selCliente = document.getElementById('db_cliente');
  const valorPrevioCliente = selCliente.value;
  selCliente.innerHTML = '<option value="">Todos los clientes</option>' + clientes.map((c) =>
    '<option value="' + c.id + '">' + esc(c.Nombres + ' ' + (c.Apellidos || '')) + ' — ' + esc(c.Cedula) + '</option>'
  ).join('');
  selCliente.value = valorPrevioCliente;

  const selRuta = document.getElementById('db_ruta');
  const valorPrevioRuta = selRuta.value;
  selRuta.innerHTML = '<option value="">Todas las rutas</option>' + rutasCache.map((r) => '<option value="' + r.id + '">' + esc(r.Nombre) + '</option>').join('');
  selRuta.value = valorPrevioRuta;

  const selCobrador = document.getElementById('db_cobrador');
  const valorPrevioCobrador = selCobrador.value;
  selCobrador.innerHTML = '<option value="">Todos los cobradores</option>' + cobradoresCache.map((c) => '<option value="' + c.id + '">' + esc(c.Nombre) + '</option>').join('');
  selCobrador.value = valorPrevioCobrador;
}

async function cargarDashboard() {
  const filtro = {
    idCliente: document.getElementById('db_cliente').value,
    idRuta: document.getElementById('db_ruta').value,
    idCobrador: document.getElementById('db_cobrador').value,
    fechaInicio: document.getElementById('db_desde').value,
    fechaFin: document.getElementById('db_hasta').value
  };
  const d = await logic.obtenerDashboard(filtro);
  renderDashboard(d);
}

const ICONOS_KPI = {
  'Total de créditos': '📋',
  'Valor total prestado': '💵',
  'Ingresos por seguro': '🛡️',
  'Ingresos por intereses': '📈',
  'Total recaudado (abonos)': '💰',
  'Cartera pendiente': '⏳'
};
const ICONOS_ESTADO = { Activo: '🔵', Pagado: '✅', Mora: '⚠️', Cancelado: '⛔' };

function renderDashboard(d) {
  CONFIG.moneda = d.moneda || CONFIG.moneda;
  const kpis = [
    ['Total de créditos', d.totalCreditos],
    ['Valor total prestado', money(d.totalPrestado)],
    ['Ingresos por seguro', money(d.totalSeguro)],
    ['Ingresos por intereses', money(d.totalInteres)],
    ['Total recaudado (abonos)', money(d.totalRecaudado)],
    ['Cartera pendiente', money(d.carteraPendiente)]
  ];
  document.getElementById('db_kpis').innerHTML = kpis.map((k) =>
    '<div class="kpi"><div class="etq"><span class="kpi-icono">' + (ICONOS_KPI[k[0]] || '') + '</span>' + k[0] + '</div><div class="valor">' + k[1] + '</div></div>'
  ).join('');

  document.getElementById('db_estados').innerHTML = Object.keys(d.porEstado).map((e) =>
    '<div class="estado-fila"><span class="badge ' + e + '">' + (ICONOS_ESTADO[e] || '') + ' ' + e + '</span><strong>' + d.porEstado[e] + '</strong></div>'
  ).join('');
}

// -------------------------------------------------------------------
// CONFIGURACION
// -------------------------------------------------------------------

async function submitConfig(ev) {
  ev.preventDefault();
  const interes = document.getElementById('cfg_interes').value;
  const seguro = document.getElementById('cfg_seguro').value;
  const moneda = document.getElementById('cfg_moneda').value;
  const capitalInicial = limpiarNumero(document.getElementById('cfg_capitalInicial').value);
  try {
    CONFIG = await logic.guardarConfig(interes, seguro, moneda, capitalInicial);
    mostrarMsg('configMsg', '✅ Configuración guardada.', 'ok');
    intentarSincronizar();
    await refrescarCapital();
  } catch (e) { manejarError(e, 'configMsg'); }
  return false;
}

// -------------------------------------------------------------------
// CAPITAL DE TRABAJO — plante inicial + inyecciones (propias o de inversionistas)
// -------------------------------------------------------------------

function onTipoCapitalChange() {
  const esInversionista = document.getElementById('cap_tipo').value === 'Inversionista';
  document.getElementById('cap_inversionistaWrap').style.display = esInversionista ? '' : 'none';
}

async function poblarDatalistInversionistas() {
  const nombres = await logic.listarInversionistasUsados();
  document.getElementById('dl_inversionistas').innerHTML = nombres.map((n) => '<option value="' + esc(n) + '">').join('');
}

async function refrescarCapital() {
  await poblarDatalistInversionistas();
  const resumen = await logic.obtenerResumenCapital();
  capitalCache = resumen.inyecciones;
  renderResumenCapital(resumen);
  renderHistorialCapital(resumen.inyecciones);
}

function renderResumenCapital(r) {
  const kpis = [
    ['Plante inicial', money(r.capitalInicial)],
    ['Total inyectado', money(r.totalInyectado)],
    ['— Recursos propios', money(r.totalPropio)],
    ['— De inversionistas', money(r.totalInversionistas)],
    ['Capital total', money(r.capitalTotal)]
  ];
  document.getElementById('cap_kpis').innerHTML = kpis.map((k) =>
    '<div class="kpi"><div class="etq">' + k[0] + '</div><div class="valor">' + k[1] + '</div></div>'
  ).join('');

  const nombres = Object.keys(r.porInversionista);
  if (nombres.length) {
    document.getElementById('cap_kpis').innerHTML += nombres.map((n) =>
      '<div class="kpi"><div class="etq">Inversionista: ' + esc(n) + '</div><div class="valor">' + money(r.porInversionista[n]) + '</div></div>'
    ).join('');
  }
}

function renderHistorialCapital(inyecciones) {
  const cont = document.getElementById('cap_historial');
  if (!inyecciones.length) { cont.innerHTML = '<p class="muted">Aún no has registrado ninguna inyección de capital.</p>'; return; }
  cont.innerHTML = inyecciones.map((c) =>
    '<div class="resultado-item" style="cursor:default;">' +
    '<div><strong>' + c.Fecha + ' · ' + (c.Tipo === 'Inversionista' ? 'Inversionista: ' + esc(c.Inversionista) : 'Recursos propios') + '</strong>' +
    (c.Nota ? '<small>' + esc(c.Nota) + '</small>' : '') + '</div>' +
    '<div class="row" style="align-items:center; gap:8px;">' +
      '<strong>' + money(c.Monto) + '</strong>' +
      '<button type="button" class="btn chico secundario" onclick="mostrarModalEditarCapital(\'' + c.id + '\')">✏️ Editar</button>' +
      '<button type="button" class="btn chico secundario" onclick="eliminarInyeccionCapital(\'' + c.id + '\')">Eliminar</button>' +
    '</div></div>'
  ).join('');
}

function mostrarModalEditarCapital(id) {
  const c = capitalCache.find((x) => x.id === id);
  if (!c) return;
  const cuerpo =
    '<div class="row">' +
      '<div class="field"><label>Fecha</label><input type="date" id="eca_fecha" value="' + esc(c.Fecha) + '"></div>' +
      '<div class="field"><label>Monto *</label><input type="text" inputmode="numeric" id="eca_monto" value="' + money(c.Monto) + '" required oninput="formatearInputMoneda(this)"></div>' +
      '<div class="field">' +
        '<label>Origen</label>' +
        '<select id="eca_tipo" onchange="onTipoCapitalEditChange()">' +
          '<option value="Propio"' + (c.Tipo !== 'Inversionista' ? ' selected' : '') + '>Recursos propios</option>' +
          '<option value="Inversionista"' + (c.Tipo === 'Inversionista' ? ' selected' : '') + '>Inversionista</option>' +
        '</select>' +
      '</div>' +
    '</div>' +
    '<div class="row" id="eca_inversionistaWrap" style="' + (c.Tipo === 'Inversionista' ? '' : 'display:none;') + '">' +
      '<div class="field"><label>Nombre del inversionista *</label><input type="text" id="eca_inversionista" value="' + esc(c.Inversionista) + '" list="dl_inversionistas"></div>' +
    '</div>' +
    '<div class="field"><label>Nota</label><input type="text" id="eca_nota" value="' + esc(c.Nota) + '"></div>';
  abrirModal('Editar inyección de capital', cuerpo, () => guardarEdicionCapital(id), 'Guardar cambios');
}

function onTipoCapitalEditChange() {
  const esInversionista = document.getElementById('eca_tipo').value === 'Inversionista';
  document.getElementById('eca_inversionistaWrap').style.display = esInversionista ? '' : 'none';
}

async function guardarEdicionCapital(id) {
  const datos = {
    Fecha: document.getElementById('eca_fecha').value,
    Monto: limpiarNumero(document.getElementById('eca_monto').value),
    Tipo: document.getElementById('eca_tipo').value,
    Inversionista: document.getElementById('eca_inversionista').value.trim(),
    Nota: document.getElementById('eca_nota').value.trim()
  };
  try {
    await logic.actualizarCapital(id, datos);
    cerrarModal();
    await refrescarCapital();
    intentarSincronizar();
  } catch (e) { manejarError(e, 'modalMsg'); }
}

async function submitCapital(ev) {
  ev.preventDefault();
  const datos = {
    Fecha: document.getElementById('cap_fecha').value,
    Monto: limpiarNumero(document.getElementById('cap_monto').value),
    Tipo: document.getElementById('cap_tipo').value,
    Inversionista: document.getElementById('cap_inversionista').value.trim(),
    Nota: document.getElementById('cap_nota').value
  };
  setCargando('btnGuardarCapital', true, 'Registrar inyección');
  try {
    await logic.registrarCapital(datos);
    mostrarMsg('capitalMsg', '✅ Inyección de capital registrada.', 'ok');
    document.getElementById('formCapital').reset();
    document.getElementById('cap_fecha').value = logic.hoyISO();
    onTipoCapitalChange();
    intentarSincronizar();
    await refrescarCapital();
  } catch (e) { manejarError(e, 'capitalMsg'); }
  setCargando('btnGuardarCapital', false, 'Registrar inyección');
  return false;
}

async function eliminarInyeccionCapital(id) {
  try {
    await logic.eliminarCapital(id);
    intentarSincronizar();
    await refrescarCapital();
  } catch (e) { manejarError(e, 'capitalMsg'); }
}

// -------------------------------------------------------------------
// SINCRONIZACIÓN CON FIREBASE (Firestore)
// -------------------------------------------------------------------
// La MISMA cuenta de Google con la que se inicia sesión en la app sirve para sincronizar
// — ya no hace falta un permiso aparte (como antes con Google Drive), así que esto ya no
// pide ventanas emergentes propias: simplemente lee/escribe en Firestore usando la sesión
// que ya existe.

function configurarSincronizacion() {
  if (!SYNC_HABILITADO) {
    mostrarSincronizacionDesactivada();
    return;
  }
  intentarSincronizar(); // sincronización silenciosa al abrir la app
  window.addEventListener('online', intentarSincronizar);
  setInterval(intentarSincronizar, 60000);
}

// Refleja en la interfaz que la sincronización está apagada temporalmente (ver SYNC_HABILITADO).
function mostrarSincronizacionDesactivada() {
  const elTexto = document.getElementById('syncTexto');
  if (elTexto) elTexto.innerHTML = '<span class="punto warn"></span>Sincronización desactivada (solo local)';
  const btnSync = document.getElementById('btnSync');
  if (btnSync) { btnSync.disabled = true; btnSync.textContent = 'Desactivada'; }
  const elEstadoCfg = document.getElementById('cap_estadoDrive');
  if (elEstadoCfg) elEstadoCfg.textContent = 'desactivada temporalmente — la app funciona solo en este dispositivo';
  const btnSyncCfg = document.getElementById('btnSyncConfig');
  if (btnSyncCfg) btnSyncCfg.disabled = true;
}

async function intentarSincronizar() {
  if (!SYNC_HABILITADO) return { ok: false, motivo: 'desactivado' };
  actualizarBarraSincronizacion('sincronizando');
  const r = await firebaseSync.sincronizarAhora();
  actualizarBarraSincronizacion(r.ok ? 'sincronizado' : r.motivo, { at: logic.nowISO() });
  if (r.ok) {
    CONFIG = await logic.getConfig();
    await recargarCaches();
    await actualizarEstadoConexionDrive();
    // Refresca lo que esté visible en ese momento sin interrumpir al usuario.
    const tabActiva = document.querySelector('#nav button.active');
    const tab = tabActiva ? tabActiva.dataset.tab : null;
    if (tab === 'clientes') {
      const vistaVisible = document.querySelector('#tab-clientes .vista:not([style*="display: none"])');
      const idVista = vistaVisible ? vistaVisible.id : '';
      if (idVista === 'vc_lista') await refrescarListaClientes();
      else if (idVista === 'vc_detalleCliente' && clienteActualId) await refrescarListaPrestamosCliente();
      else if (idVista === 'vc_detallePrestamo' && prestamoActualId) await refrescarDetallePrestamo();
    } else if (tab === 'rutas') {
      await refrescarRutas();
    } else if (tab === 'cobradores') {
      await refrescarCobradores();
    } else if (tab === 'dashboard') {
      await cargarSelectsDashboard();
      await cargarDashboard();
    } else if (tab === 'configuracion') {
      await refrescarCapital();
    }
  }
  return r;
}

/** Botón "Sincronizar": como ya se inició sesión para poder usar la app, esto solo lee y
 *  escribe en Firestore — no hay ninguna ventana emergente ni permiso adicional que pedir. */
async function onClicSincronizar() {
  if (!SYNC_HABILITADO) {
    switchTab('configuracion');
    mostrarMsg('driveMsg', 'La sincronización está desactivada temporalmente. Tus datos se guardan sin problema en este dispositivo mientras tanto.', 'info');
    return;
  }
  const r = await intentarSincronizar();
  if (!r.ok && r.motivo === 'sin_conexion') {
    switchTab('configuracion');
    mostrarMsg('driveMsg', 'No hay conexión a internet en este momento. Tus cambios quedan guardados en este dispositivo y se sincronizarán apenas vuelva la señal.', 'info');
  }
  if (!r.ok && r.motivo === 'sin_autorizacion') {
    switchTab('configuracion');
    mostrarMsg('driveMsg', 'Tu sesión expiró — cierra sesión (botón "Salir") y vuelve a entrar para poder sincronizar.', 'error');
  }
  if (!r.ok && r.motivo === 'error') {
    // El motivo real (tal como lo reporta Firebase) se muestra aquí para poder
    // diagnosticarlo sin tener que abrir la consola del navegador.
    switchTab('configuracion');
    mostrarMsg('driveMsg', 'No se pudo sincronizar: ' + (r.mensaje || 'error desconocido') + '.', 'error');
  }
}

async function actualizarEstadoConexionDrive() {
  const el = document.getElementById('cap_estadoDrive');
  if (!el) return;
  const email = firebaseSync.correoActual();
  el.textContent = email ? ('activa (' + email + ')') : 'no conectado';
}

function actualizarBarraSincronizacion(estado, detalle) {
  const el = document.getElementById('syncTexto');
  const mapa = {
    sincronizando: ['warn', 'Sincronizando…'],
    sincronizado: ['ok', 'Sincronizado' + (detalle && detalle.at ? ' a las ' + new Date(detalle.at).toLocaleTimeString('es-CO') : '')],
    sin_conexion: ['warn', 'Sin conexión — cambios guardados localmente'],
    sin_autorizacion: ['warn', 'Sesión expirada — vuelve a entrar para sincronizar'],
    error: ['err', 'Error al sincronizar']
  };
  const [clase, texto] = mapa[estado] || ['warn', 'Iniciando…'];
  el.innerHTML = '<span class="punto ' + clase + '"></span>' + texto;
}

// -------------------------------------------------------------------
// SERVICE WORKER (modo sin conexión)
// -------------------------------------------------------------------

function registrarServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.error('Error registrando service worker:', e));
  }
}

// -------------------------------------------------------------------
// CONTROL DE ACCESO (inicio de sesión con Google vía Firebase Authentication)
// -------------------------------------------------------------------
// Flujo:
//   1. Al cargar la página, Firebase revisa por su cuenta si ya había una sesión guardada
//      en este dispositivo (no hace falta que la app guarde nada a mano, a diferencia de
//      antes con localStorage).
//   2. Si no hay sesión, se muestra el botón "Iniciar sesión con Google". Firebase
//      confirma la cuenta de forma verificada (no es un token que la app decodifica por
//      su cuenta, como antes).
//   3. Si el correo está en la lista blanca (o es una cuenta de respaldo), se muestra la
//      app. Si no, se cierra esa sesión y se avisa, para que pueda intentar con otra cuenta.
//   La MISMA sesión sirve también para sincronizar contra Firestore (ver SINCRONIZACIÓN
//   más abajo) — ya no hace falta un segundo permiso aparte, como antes con Google Drive.

function iniciarControlDeAcceso() {
  try {
    firebaseSync.onCambioSesion(async (user) => {
      if (!user || !user.email) { mostrarLockScreen(); return; }
      const email = String(user.email).toLowerCase().trim();
      const autorizado = await logic.estaCorreoAutorizado(email);
      if (!autorizado) {
        await firebaseSync.cerrarSesion();
        mostrarLockScreen('La cuenta ' + email + ' no está autorizada para entrar a esta app.');
        return;
      }
      mostrarApp(email);
    });
  } catch (e) {
    // Si Firebase no cargó (sin internet, bloqueado, o falta configurar FIREBASE_CONFIG en
    // js/config-local.js) no hay que dejar la pantalla de bloqueo esperando para siempre:
    // se avisa y se oculta el botón (no serviría de nada mostrarlo si Firebase no cargó).
    mostrarLockScreen(e.message || 'No se pudo conectar con Firebase. Revisa tu conexión a internet.');
    document.getElementById('btnIniciarSesionGoogle').style.display = 'none';
  }
}

function mostrarLockScreen(mensaje) {
  document.getElementById('appShell').style.display = 'none';
  const lock = document.getElementById('lockScreen');
  lock.style.display = 'flex';
  const elMsg = document.getElementById('lockMsg');
  if (mensaje) { elMsg.textContent = mensaje; elMsg.className = 'msg error'; }
  else { elMsg.textContent = ''; elMsg.className = ''; }
  document.getElementById('btnIniciarSesionGoogle').style.display = '';
}

async function onClicIniciarSesionGoogle() {
  const elMsg = document.getElementById('lockMsg');
  elMsg.textContent = '';
  elMsg.className = '';
  try {
    await firebaseSync.iniciarSesionGoogle();
    // iniciarControlDeAcceso() ya está escuchando los cambios de sesión: en cuanto Google
    // confirme la cuenta, se encarga de validar el correo y mostrar la app (o rechazarlo).
  } catch (e) {
    if (e && (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request')) return;
    elMsg.textContent = 'No se pudo iniciar sesión: ' + (e.message || 'intenta de nuevo.');
    elMsg.className = 'msg error';
  }
}

async function mostrarApp(email) {
  document.getElementById('lockScreen').style.display = 'none';
  document.getElementById('appShell').style.display = '';
  window._correoSesionActual = email;
  await _resolverRestriccionCobrador(email);
  init();
}

/** Decide si la cuenta que acaba de entrar ve toda la app (el dueño) o solo los clientes
 *  de su(s) propia(s) ruta(s) (un cobrador vinculado por correo). */
async function _resolverRestriccionCobrador(email) {
  const limpio = String(email || '').toLowerCase().trim();
  if (logic.CORREOS_RESPALDO.includes(limpio)) {
    restriccionCobrador = null;
    rutasIdsCobradorActual = [];
    return;
  }
  const cobrador = await logic.obtenerCobradorPorCorreo(limpio);
  restriccionCobrador = cobrador || null;
  rutasIdsCobradorActual = cobrador ? (await logic.listarRutasPorCobrador(cobrador.id)).map((r) => r.id) : [];
}

/** Oculta del menú todo lo que no sea "Clientes" y esconde los filtros de ruta/cobrador
 *  de la lista de clientes, cuando la cuenta activa es la de un cobrador restringido. */
function aplicarRestriccionCobradorEnUI() {
  const restringido = !!restriccionCobrador;
  ['dashboard', 'rutas', 'cobradores', 'configuracion'].forEach((tab) => {
    const btn = document.querySelector('#nav button[data-tab="' + tab + '"]');
    if (btn) btn.style.display = restringido ? 'none' : '';
  });
  const wrapCobrador = document.getElementById('cl_cobradorWrap');
  if (wrapCobrador) wrapCobrador.style.display = restringido ? 'none' : '';
  const selRuta = document.getElementById('cl_ruta');
  if (selRuta && selRuta.closest('.field')) selRuta.closest('.field').style.display = restringido ? 'none' : '';
  if (restringido) switchTab('clientes');
}

function cerrarSesionApp() {
  firebaseSync.cerrarSesion().finally(() => location.reload());
}

// -------------------------------------------------------------------
// CONFIGURACIÓN → ACCESO A LA APP (gestión de la lista blanca de correos)
// -------------------------------------------------------------------

async function refrescarListaCorreosAutorizados() {
  const cont = document.getElementById('accesoLista');
  if (!cont) return;
  // Las cuentas de respaldo (logic.CORREOS_RESPALDO) siguen teniendo acceso fijo por
  // detrás, pero ya no se muestran en esta lista.
  const lista = await logic.listarCorreosAutorizados();
  const filasEditables = lista.map((correo) =>
    '<div class="resultado-item estatico"><div class="ri-body"><strong>' + correo + '</strong></div>' +
    '<button type="button" class="btn secundario chico" onclick="onClicQuitarCorreo(\'' + correo.replace(/'/g, "\\'") + '\')">Quitar</button></div>'
  );
  cont.innerHTML = filasEditables.join('');
}

async function onClicAgregarCorreo(ev) {
  ev.preventDefault();
  const input = document.getElementById('acceso_correo');
  try {
    await logic.agregarCorreoAutorizado(input.value);
    input.value = '';
    await refrescarListaCorreosAutorizados();
    mostrarMsg('accesoMsg', 'Correo agregado.', 'ok');
  } catch (e) { manejarError(e, 'accesoMsg'); }
  return false;
}

async function onClicQuitarCorreo(correo) {
  await logic.quitarCorreoAutorizado(correo);
  await refrescarListaCorreosAutorizados();
  mostrarMsg('accesoMsg', 'Correo quitado. Si esa persona ya había iniciado sesión en su dispositivo, se le pedirá iniciar sesión de nuevo la próxima vez que abra la app.', 'info');
}
