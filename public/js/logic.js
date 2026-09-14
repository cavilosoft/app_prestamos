/**
 * logic.js — reglas de negocio y acceso a datos (equivalente al antiguo Code.gs, pero
 * leyendo/escribiendo en IndexedDB local en vez de Google Sheets). No sabe nada de UI
 * ni de Firebase: firebase-sync.js se encarga de sincronizar lo que aquí se guarda.
 */

const ESTADOS = { ACTIVO: 'Activo', PAGADO: 'Pagado', MORA: 'Mora', CANCELADO: 'Cancelado' };

// -------------------------------------------------------------------------
// UTILIDADES
// -------------------------------------------------------------------------

function nowISO() {
  return new Date().toISOString();
}

function hoyISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Genera un ID único sin necesidad de coordinación entre dispositivos (importante:
 * portátil y celular pueden crear registros al mismo tiempo estando ambos sin internet).
 */
function generarId(prefix) {
  const azar = (crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(16) + Math.random().toString(16).slice(2)));
  return prefix + '-' + azar.replace(/-/g, '').slice(0, 10).toUpperCase();
}

function parseFecha(iso) {
  if (!iso) return null;
  const partes = String(iso).split('-');
  if (partes.length !== 3) return new Date(iso);
  return new Date(parseInt(partes[0], 10), parseInt(partes[1], 10) - 1, parseInt(partes[2], 10));
}

// -------------------------------------------------------------------------
// FUSIÓN DE DATOS (merge) — usada por sync.js al conciliar local vs. Google Drive
// -------------------------------------------------------------------------

/**
 * Combina dos mapas {id: registro} de la misma colección. Ante un mismo id en ambos
 * lados, gana el registro con updatedAt más reciente ("last write wins"). Estrategia
 * simple e intencional: para este tipo de negocio (préstamos gota a gota) es muy raro
 * que el mismo registro se edite en el portátil y el celular en la misma ventana sin
 * conexión; y si pasa, se prefiere el cambio más nuevo antes que bloquear al usuario
 * con una pantalla de "resolver conflicto".
 */
function fusionarColeccion(mapaLocal, mapaRemoto) {
  const resultado = {};
  const ids = new Set([...Object.keys(mapaLocal || {}), ...Object.keys(mapaRemoto || {})]);
  ids.forEach((id) => {
    const l = mapaLocal && mapaLocal[id];
    const r = mapaRemoto && mapaRemoto[id];
    if (l && r) {
      resultado[id] = (String(l.updatedAt || '') >= String(r.updatedAt || '')) ? l : r;
    } else {
      resultado[id] = l || r;
    }
  });
  return resultado;
}

function fusionarConfig(local, remoto) {
  if (!local) return remoto;
  if (!remoto) return local;
  return (String(local.updatedAt || '') >= String(remoto.updatedAt || '')) ? local : remoto;
}

// -------------------------------------------------------------------------
// CONFIGURACIÓN (parámetros del sistema)
// -------------------------------------------------------------------------

async function getConfig() {
  const cfg = await idb.kvGet('config');
  if (!cfg) return { interes: 20, seguro: 5, moneda: 'COP', capitalInicial: 0, updatedAt: nowISO() };
  // Compatibilidad con configuraciones guardadas antes de que existiera el capital inicial.
  if (cfg.capitalInicial === undefined) cfg.capitalInicial = 0;
  return cfg;
}

async function guardarConfig(interes, seguro, moneda, capitalInicial) {
  // Importante: se hace merge sobre la config actual (no se reemplaza entera), porque
  // config también guarda cosas que este formulario no toca, como la lista de correos
  // autorizados (ver ACCESO A LA APP más abajo). Guardar solo interes/seguro/moneda/capital
  // no debe borrar esa lista.
  const actual = await getConfig();
  const cfg = Object.assign({}, actual, {
    interes: Number(interes),
    seguro: Number(seguro),
    moneda: String(moneda || 'COP'),
    capitalInicial: Number(capitalInicial) || 0,
    updatedAt: nowISO()
  });
  await idb.kvSet('config', cfg);
  return cfg;
}

// -------------------------------------------------------------------------
// ACCESO A LA APP (lista blanca de correos autorizados)
// -------------------------------------------------------------------------
// El dueño del negocio decide qué cuentas de Google pueden entrar a la app. La lista vive
// dentro de config (correosAutorizados: string[]). Además, las CORREOS_RESPALDO siempre
// pueden entrar sin importar la lista, para que estas cuentas nunca queden bloqueadas de
// la app (por ejemplo si alguna se borra por error de la lista). A diferencia de los
// correos que se agregan desde Configuración, estas quedan fijas en el código: no se
// pueden quitar desde la app. CORREOS_RESPALDO vive en js/config-local.js (se carga antes
// que este archivo) — así no hay que volver a definirla cada vez que logic.js se actualiza.

function _normalizarCorreo(correo) {
  return String(correo || '').trim().toLowerCase();
}

async function listarCorreosAutorizados() {
  const cfg = await getConfig();
  return Array.isArray(cfg.correosAutorizados) ? cfg.correosAutorizados : [];
}

async function agregarCorreoAutorizado(correo) {
  const limpio = _normalizarCorreo(correo);
  if (!limpio || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(limpio)) {
    throw new Error('Ingresa un correo válido.');
  }
  const actual = await getConfig();
  const lista = Array.isArray(actual.correosAutorizados) ? actual.correosAutorizados.slice() : [];
  if (!lista.includes(limpio)) lista.push(limpio);
  const cfg = Object.assign({}, actual, { correosAutorizados: lista, updatedAt: nowISO() });
  await idb.kvSet('config', cfg);
  return lista;
}

async function quitarCorreoAutorizado(correo) {
  const limpio = _normalizarCorreo(correo);
  const actual = await getConfig();
  const lista = (Array.isArray(actual.correosAutorizados) ? actual.correosAutorizados : []).filter((c) => c !== limpio);
  const cfg = Object.assign({}, actual, { correosAutorizados: lista, updatedAt: nowISO() });
  await idb.kvSet('config', cfg);
  return lista;
}

async function estaCorreoAutorizado(correo) {
  const limpio = _normalizarCorreo(correo);
  if (!limpio) return false;
  if (CORREOS_RESPALDO.includes(limpio)) return true;
  const lista = await listarCorreosAutorizados();
  return lista.includes(limpio);
}

// -------------------------------------------------------------------------
// CLIENTES
// -------------------------------------------------------------------------

async function listarClientes() {
  const todos = await idb.obtenerTodos('clientes');
  return todos.filter((c) => !c.deleted).sort((a, b) => String(a.Nombres).localeCompare(String(b.Nombres)));
}

async function buscarClientes(query) {
  const todos = await listarClientes();
  if (!query) return todos;
  const q = String(query).toLowerCase().trim();
  return todos.filter((c) => {
    const nombreCompleto = (String(c.Nombres || '') + ' ' + String(c.Apellidos || '')).toLowerCase();
    return String(c.Cedula || '').toLowerCase().includes(q) ||
      nombreCompleto.includes(q) ||
      String(c.Celular || '').toLowerCase().includes(q) ||
      String(c.id || '').toLowerCase().includes(q);
  });
}

/**
 * Lista de clientes con filtros y paginación, para la pantalla principal.
 * opciones: { pagina, tamano, query, ciudad, idRuta, idCobrador }.
 * idCobrador filtra por todas las rutas de ese cobrador (un cobrador puede tener varias rutas).
 */
async function listarClientesPaginado(opciones) {
  opciones = opciones || {};
  let items = await buscarClientes(opciones.query);

  if (opciones.ciudad) items = items.filter((c) => c.Ciudad === opciones.ciudad);
  if (opciones.idRuta) items = items.filter((c) => c.ID_Ruta === opciones.idRuta);
  if (opciones.idCobrador) {
    const rutas = await listarRutas();
    const idsRutasCobrador = new Set(rutas.filter((r) => r.ID_Cobrador === opciones.idCobrador).map((r) => r.id));
    items = items.filter((c) => idsRutasCobrador.has(c.ID_Ruta));
  }

  const total = items.length;
  const tamano = Number(opciones.tamano) || 20;
  const pagina = Math.max(1, Number(opciones.pagina) || 1);
  const totalPaginas = Math.max(1, Math.ceil(total / tamano));
  const inicio = (Math.min(pagina, totalPaginas) - 1) * tamano;

  return { items: items.slice(inicio, inicio + tamano), total, pagina: Math.min(pagina, totalPaginas), tamano, totalPaginas };
}

/** Valores únicos de ciudad ya registrados, para poblar el filtro. */
async function listarCiudadesUsadas() {
  const todos = await listarClientes();
  const set = new Set(todos.map((c) => c.Ciudad).filter(Boolean));
  return Array.from(set).sort();
}

async function obtenerCliente(id) {
  return idb.obtenerPorId('clientes', id);
}

async function crearCliente(datos) {
  if (!datos.Cedula) throw new Error('La cédula es obligatoria.');
  if (!datos.Nombres) throw new Error('El nombre es obligatorio.');

  const existentes = await listarClientes();
  if (existentes.some((c) => String(c.Cedula) === String(datos.Cedula))) {
    throw new Error('Ya existe un cliente registrado con la cédula ' + datos.Cedula + '.');
  }

  const cliente = {
    id: generarId('CLI'),
    Cedula: datos.Cedula,
    Nombres: datos.Nombres,
    Apellidos: datos.Apellidos || '',
    Celular: datos.Celular || '',
    Direccion: datos.Direccion || '',
    Ciudad: datos.Ciudad || '',
    Geolocalizacion: datos.Geolocalizacion || '',
    Ocupacion: datos.Ocupacion || '',
    Punto_Referencia: datos.Punto_Referencia || '',
    Nota: datos.Nota || '',
    ID_Ruta: datos.ID_Ruta || null,
    Fecha_Registro: hoyISO(),
    updatedAt: nowISO(),
    deleted: false
  };
  await idb.guardar('clientes', cliente);
  return cliente;
}

async function actualizarCliente(id, datos) {
  const actual = await obtenerCliente(id);
  if (!actual) throw new Error('Cliente no encontrado.');

  if (datos.Cedula !== undefined && String(datos.Cedula) !== String(actual.Cedula)) {
    const existentes = await listarClientes();
    if (existentes.some((c) => c.id !== id && String(c.Cedula) === String(datos.Cedula))) {
      throw new Error('Ya existe otro cliente registrado con la cédula ' + datos.Cedula + '.');
    }
  }

  const campos = ['Cedula', 'Nombres', 'Apellidos', 'Celular', 'Direccion', 'Ciudad', 'Geolocalizacion', 'Ocupacion', 'Punto_Referencia', 'Nota', 'ID_Ruta'];
  campos.forEach((c) => { if (datos[c] !== undefined) actual[c] = datos[c]; });
  actual.updatedAt = nowISO();
  await idb.guardar('clientes', actual);
  return actual;
}

// -------------------------------------------------------------------------
// RUTAS
// -------------------------------------------------------------------------

async function listarRutas() {
  const todos = await idb.obtenerTodos('rutas');
  return todos.filter((r) => !r.deleted).sort((a, b) => String(a.Nombre).localeCompare(String(b.Nombre)));
}

async function obtenerRuta(id) {
  return idb.obtenerPorId('rutas', id);
}

async function crearRuta(datos) {
  if (!datos.Nombre) throw new Error('El nombre de la ruta es obligatorio.');
  const ruta = {
    id: generarId('RUT'),
    Nombre: datos.Nombre,
    ID_Cobrador: datos.ID_Cobrador || null,
    Nota: datos.Nota || '',
    updatedAt: nowISO(),
    deleted: false
  };
  await idb.guardar('rutas', ruta);
  return ruta;
}

async function actualizarRuta(id, datos) {
  const actual = await obtenerRuta(id);
  if (!actual) throw new Error('Ruta no encontrada.');
  const campos = ['Nombre', 'ID_Cobrador', 'Nota'];
  campos.forEach((c) => { if (datos[c] !== undefined) actual[c] = datos[c]; });
  actual.updatedAt = nowISO();
  await idb.guardar('rutas', actual);
  return actual;
}

/** Cuenta cuántos clientes tiene cada ruta (para mostrarlo en la lista de rutas). */
async function contarClientesPorRuta() {
  const clientes = await listarClientes();
  const conteo = {};
  clientes.forEach((c) => { if (c.ID_Ruta) conteo[c.ID_Ruta] = (conteo[c.ID_Ruta] || 0) + 1; });
  return conteo;
}

// -------------------------------------------------------------------------
// COBRADORES
// -------------------------------------------------------------------------

async function listarCobradores() {
  const todos = await idb.obtenerTodos('cobradores');
  return todos.filter((c) => !c.deleted).sort((a, b) => String(a.Nombre).localeCompare(String(b.Nombre)));
}

async function obtenerCobrador(id) {
  return idb.obtenerPorId('cobradores', id);
}

/**
 * Busca el cobrador cuyo correo (el mismo que usa para iniciar sesión) coincide con el
 * dado. Se usa para saber si la cuenta que acaba de entrar debe verlo todo (el dueño) o
 * solo los clientes de su(s) propia(s) ruta(s) (un cobrador). Devuelve null si el correo
 * no está vinculado a ningún cobrador.
 */
async function obtenerCobradorPorCorreo(correo) {
  const limpio = _normalizarCorreo(correo);
  if (!limpio) return null;
  const todos = await listarCobradores();
  return todos.find((c) => String(c.Email || '').toLowerCase().trim() === limpio) || null;
}

async function crearCobrador(datos) {
  if (!datos.Nombre) throw new Error('El nombre es obligatorio.');
  if (!datos.Email) throw new Error('El correo de Google del cobrador es obligatorio.');
  const email = String(datos.Email).toLowerCase().trim();
  const existentes = await listarCobradores();
  if (existentes.some((c) => String(c.Email || '').toLowerCase().trim() === email)) {
    throw new Error('Ya existe un cobrador con ese correo.');
  }
  const cobrador = {
    id: generarId('COB'),
    Nombre: datos.Nombre,
    Email: email,
    Telefono: datos.Telefono || '',
    Activo: datos.Activo !== false,
    updatedAt: nowISO(),
    deleted: false
  };
  await idb.guardar('cobradores', cobrador);
  return cobrador;
}

async function actualizarCobrador(id, datos) {
  const actual = await obtenerCobrador(id);
  if (!actual) throw new Error('Cobrador no encontrado.');

  if (datos.Email !== undefined) {
    const email = String(datos.Email).toLowerCase().trim();
    if (!email) throw new Error('El correo de Google del cobrador es obligatorio.');
    if (email !== actual.Email) {
      const existentes = await listarCobradores();
      if (existentes.some((c) => c.id !== id && String(c.Email || '').toLowerCase().trim() === email)) {
        throw new Error('Ya existe otro cobrador con ese correo.');
      }
    }
    actual.Email = email;
  }
  if (datos.Nombre !== undefined) actual.Nombre = datos.Nombre;
  if (datos.Telefono !== undefined) actual.Telefono = datos.Telefono;
  if (datos.Activo !== undefined) actual.Activo = !!datos.Activo;
  actual.updatedAt = nowISO();
  await idb.guardar('cobradores', actual);
  return actual;
}

/** Rutas asignadas a un cobrador (un cobrador puede tener varias). */
async function listarRutasPorCobrador(idCobrador) {
  const rutas = await listarRutas();
  return rutas.filter((r) => r.ID_Cobrador === idCobrador);
}

// -------------------------------------------------------------------------
// PRÉSTAMOS
// -------------------------------------------------------------------------

/** Calcula seguro / interés / monto a pagar sugeridos a partir del monto prestado. */
async function calcularSugerido(montoPrestado, porcentajeInteres, porcentajeSeguro) {
  const config = await getConfig();
  const pInteres = (porcentajeInteres === undefined || porcentajeInteres === null || porcentajeInteres === '') ? config.interes : Number(porcentajeInteres);
  const pSeguro = (porcentajeSeguro === undefined || porcentajeSeguro === null || porcentajeSeguro === '') ? config.seguro : Number(porcentajeSeguro);
  const monto = Number(montoPrestado) || 0;

  const valorSeguro = round2(monto * (pSeguro / 100));
  const montoEntregado = round2(monto - valorSeguro);
  const valorInteres = round2(monto * (pInteres / 100));
  const montoAPagar = round2(monto + valorInteres);

  return { porcentajeInteres: pInteres, porcentajeSeguro: pSeguro, valorSeguro, montoEntregado, valorInteres, montoAPagar };
}

/**
 * datos: ID_Cliente, Fecha_Prestamo, Monto_Prestado, Porcentaje_Seguro, Porcentaje_Interes,
 * Monto_A_Pagar (si el usuario lo edita manualmente, se recalcula el interés a partir de él),
 * Fecha_Pago (fecha de la última cuota del plan de pagos), Frecuencia_Pago,
 * Plan_Pagos ([{numero, fecha, valor}, ...] — el detalle de cada cuota, solo informativo:
 * el saldo pendiente se sigue calculando contra Monto_A_Pagar y los abonos reales), Nota.
 */
async function crearPrestamo(datos) {
  if (!datos.ID_Cliente) throw new Error('Debe seleccionar un cliente.');
  const monto = Number(datos.Monto_Prestado);
  if (!monto || monto <= 0) throw new Error('El monto prestado debe ser mayor a cero.');
  if (!datos.Fecha_Pago) throw new Error('La fecha de pago es obligatoria.');

  const cliente = await obtenerCliente(datos.ID_Cliente);
  if (!cliente) throw new Error('El cliente indicado no existe.');

  const config = await getConfig();
  const pSeguro = (datos.Porcentaje_Seguro === undefined || datos.Porcentaje_Seguro === '' || datos.Porcentaje_Seguro === null) ? config.seguro : Number(datos.Porcentaje_Seguro);
  const valorSeguro = round2(monto * (pSeguro / 100));
  const montoEntregado = round2(monto - valorSeguro);

  let montoAPagar, valorInteres, pInteres;
  if (datos.Monto_A_Pagar !== undefined && datos.Monto_A_Pagar !== '' && datos.Monto_A_Pagar !== null) {
    montoAPagar = round2(Number(datos.Monto_A_Pagar));
    valorInteres = round2(montoAPagar - monto);
    pInteres = monto > 0 ? round2((valorInteres / monto) * 100) : 0;
  } else {
    pInteres = (datos.Porcentaje_Interes === undefined || datos.Porcentaje_Interes === '' || datos.Porcentaje_Interes === null) ? config.interes : Number(datos.Porcentaje_Interes);
    valorInteres = round2(monto * (pInteres / 100));
    montoAPagar = round2(monto + valorInteres);
  }

  const prestamo = {
    id: generarId('PRE'),
    ID_Cliente: datos.ID_Cliente,
    Fecha_Prestamo: datos.Fecha_Prestamo || hoyISO(),
    Monto_Prestado: monto,
    Porcentaje_Seguro: pSeguro,
    Valor_Seguro: valorSeguro,
    Monto_Entregado: montoEntregado,
    Porcentaje_Interes: pInteres,
    Valor_Interes: valorInteres,
    Monto_A_Pagar: montoAPagar,
    Fecha_Pago: datos.Fecha_Pago,
    Frecuencia_Pago: datos.Frecuencia_Pago || 'Único pago',
    Plan_Pagos: Array.isArray(datos.Plan_Pagos)
      ? datos.Plan_Pagos.map((c, i) => ({ numero: c.numero || (i + 1), fecha: c.fecha, valor: round2(Number(c.valor) || 0) }))
      : [],
    Nota: datos.Nota || '',
    estadoManual: null, // solo se usa para marcar 'Cancelado' a mano; lo demás se calcula
    Fecha_Registro: hoyISO(),
    updatedAt: nowISO(),
    deleted: false
  };
  await idb.guardar('prestamos', prestamo);
  return enriquecerPrestamo(prestamo, []);
}

/**
 * Corrige los datos "de cabecera" de un préstamo ya creado (fecha, monto, seguro,
 * interés, monto a pagar, fecha de pago, nota) — por ejemplo, un error de digitación.
 * No toca el plan de cuotas, el estado manual, el historial de retanqueos ni los abonos
 * ya registrados: el saldo pendiente se sigue calculando solo a partir de Monto_A_Pagar
 * y los abonos reales, así que no hay nada más que arrastrar.
 * datos: { Fecha_Prestamo, Monto_Prestado, Porcentaje_Seguro, Valor_Seguro,
 *          Monto_Entregado, Porcentaje_Interes, Valor_Interes, Monto_A_Pagar,
 *          Fecha_Pago, Frecuencia_Pago, Nota }
 */
async function actualizarPrestamo(id, datos) {
  const actual = await idb.obtenerPorId('prestamos', id);
  if (!actual) throw new Error('Préstamo no encontrado.');

  const monto = datos.Monto_Prestado !== undefined ? Number(datos.Monto_Prestado) : actual.Monto_Prestado;
  if (!monto || monto <= 0) throw new Error('El monto prestado debe ser mayor a cero.');
  const fechaPago = datos.Fecha_Pago !== undefined ? datos.Fecha_Pago : actual.Fecha_Pago;
  if (!fechaPago) throw new Error('La fecha de pago es obligatoria.');

  const CAMPOS_NUMERICOS = ['Monto_Prestado', 'Porcentaje_Seguro', 'Valor_Seguro', 'Monto_Entregado', 'Porcentaje_Interes', 'Valor_Interes', 'Monto_A_Pagar'];
  const CAMPOS_TEXTO = ['Fecha_Prestamo', 'Fecha_Pago', 'Frecuencia_Pago', 'Nota'];

  CAMPOS_NUMERICOS.forEach((c) => { if (datos[c] !== undefined) actual[c] = round2(Number(datos[c]) || 0); });
  CAMPOS_TEXTO.forEach((c) => { if (datos[c] !== undefined) actual[c] = datos[c]; });

  actual.updatedAt = nowISO();
  await idb.guardar('prestamos', actual);
  return obtenerPrestamo(id);
}

async function actualizarEstadoManual(idPrestamo, nuevoEstado) {
  const prestamo = await idb.obtenerPorId('prestamos', idPrestamo);
  if (!prestamo) throw new Error('Préstamo no encontrado.');
  prestamo.estadoManual = nuevoEstado || null;
  prestamo.updatedAt = nowISO();
  await idb.guardar('prestamos', prestamo);
  return obtenerPrestamo(idPrestamo);
}

/** Determina el estado real de un préstamo. Nunca se guarda: siempre se calcula al leer. */
function calcularEstado(prestamo, saldo) {
  if (prestamo.estadoManual === ESTADOS.CANCELADO) return ESTADOS.CANCELADO;
  if (saldo <= 0.009) return ESTADOS.PAGADO;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const fechaPago = parseFecha(prestamo.Fecha_Pago);
  if (fechaPago && hoy > fechaPago) return ESTADOS.MORA;
  return ESTADOS.ACTIVO;
}

/**
 * abonos = TODO el historial de abonos del préstamo (se muestra completo en la UI).
 * Si el préstamo tuvo un retanqueo, solo los abonos posteriores a ese retanqueo cuentan
 * para el saldo vigente — los anteriores ya quedaron reflejados en el saldo que se
 * "arrastró" hacia el nuevo monto a pagar en ese momento.
 */
function enriquecerPrestamo(prestamo, abonos) {
  const corte = prestamo.Fecha_Ultimo_Retanqueo || null;
  const abonosVigentes = corte ? abonos.filter((a) => String(a.updatedAt || '') > String(corte)) : abonos;
  const totalAbonado = abonosVigentes.reduce((s, a) => s + Number(a.Valor_Abono || 0), 0);
  const saldo = round2(Number(prestamo.Monto_A_Pagar || 0) - totalAbonado);
  return Object.assign({}, prestamo, {
    Abonos: abonos,
    Total_Abonado: round2(totalAbonado),
    Saldo_Pendiente: saldo,
    Estado: calcularEstado(prestamo, saldo),
    Historial_Retanqueos: prestamo.Historial_Retanqueos || []
  });
}

async function obtenerAbonosPorPrestamo(idPrestamo) {
  const todos = await idb.obtenerTodos('abonos');
  return todos
    .filter((a) => !a.deleted && String(a.ID_Prestamo) === String(idPrestamo))
    .sort((a, b) => String(a.Fecha_Abono).localeCompare(String(b.Fecha_Abono)));
}

async function obtenerPrestamo(idPrestamo) {
  const prestamo = await idb.obtenerPorId('prestamos', idPrestamo);
  if (!prestamo) return null;
  const abonos = await obtenerAbonosPorPrestamo(idPrestamo);
  return enriquecerPrestamo(prestamo, abonos);
}

async function obtenerPrestamosPorCliente(idCliente) {
  const todos = await idb.obtenerTodos('prestamos');
  const abonosTodos = await idb.obtenerTodos('abonos');
  const propios = todos.filter((p) => !p.deleted && String(p.ID_Cliente) === String(idCliente));

  const enriquecidos = propios.map((p) => {
    const abonos = abonosTodos
      .filter((a) => !a.deleted && String(a.ID_Prestamo) === String(p.id))
      .sort((a, b) => String(a.Fecha_Abono).localeCompare(String(b.Fecha_Abono)));
    return enriquecerPrestamo(p, abonos);
  });

  enriquecidos.sort((a, b) => String(b.Fecha_Prestamo).localeCompare(String(a.Fecha_Prestamo)));
  return enriquecidos;
}

/** Préstamos de un cliente, más recientes primero, con filtro de estado y paginación. */
async function listarPrestamosPorClientePaginado(idCliente, opciones) {
  opciones = opciones || {};
  let items = await obtenerPrestamosPorCliente(idCliente); // ya viene ordenado desc por fecha
  if (opciones.estado) items = items.filter((p) => p.Estado === opciones.estado);

  const total = items.length;
  const tamano = Number(opciones.tamano) || 10;
  const pagina = Math.max(1, Number(opciones.pagina) || 1);
  const totalPaginas = Math.max(1, Math.ceil(total / tamano));
  const inicio = (Math.min(pagina, totalPaginas) - 1) * tamano;

  return { items: items.slice(inicio, inicio + tamano), total, pagina: Math.min(pagina, totalPaginas), tamano, totalPaginas };
}

async function obtenerHistorialCliente(idCliente) {
  const cliente = await obtenerCliente(idCliente);
  if (!cliente) throw new Error('Cliente no encontrado.');
  const prestamos = await obtenerPrestamosPorCliente(idCliente);
  return { cliente, prestamos };
}

// -------------------------------------------------------------------------
// ABONOS
// -------------------------------------------------------------------------

/** Total abonado y saldo vigentes, respetando el corte de un eventual retanqueo. */
function _totalVigenteYSaldo(prestamo, abonos) {
  const corte = prestamo.Fecha_Ultimo_Retanqueo || null;
  const abonosVigentes = corte ? abonos.filter((a) => String(a.updatedAt || '') > String(corte)) : abonos;
  const totalVigente = abonosVigentes.reduce((s, a) => s + Number(a.Valor_Abono || 0), 0);
  return { totalVigente: round2(totalVigente), saldo: round2(Number(prestamo.Monto_A_Pagar || 0) - totalVigente) };
}

async function registrarAbono(idPrestamo, fechaAbono, valorAbono, nota) {
  const valor = Number(valorAbono);
  if (!valor || valor <= 0) throw new Error('El valor del abono debe ser mayor a cero.');

  const prestamo = await idb.obtenerPorId('prestamos', idPrestamo);
  if (!prestamo) throw new Error('Préstamo no encontrado.');

  const abonosPrevios = await obtenerAbonosPorPrestamo(idPrestamo);
  const { saldo: saldoPrevio } = _totalVigenteYSaldo(prestamo, abonosPrevios);
  const nuevoSaldo = round2(saldoPrevio - valor);
  if (nuevoSaldo < -0.01) {
    throw new Error('El abono excede el saldo pendiente (saldo actual: ' + saldoPrevio + ').');
  }

  const abono = {
    id: generarId('ABO'),
    ID_Prestamo: idPrestamo,
    Fecha_Abono: fechaAbono || hoyISO(),
    Valor_Abono: valor,
    Nota: nota || '',
    Fecha_Registro: hoyISO(),
    updatedAt: nowISO(),
    deleted: false
  };
  await idb.guardar('abonos', abono);
  return obtenerPrestamo(idPrestamo);
}

/**
 * Marca una cuota del plan de pagos como pagada: registra su valor como abono real del
 * préstamo (afecta el saldo pendiente igual que cualquier otro abono) y deja la cuota marcada
 * en Plan_Pagos para que la interfaz la muestre como pagada. No se puede marcar dos veces.
 */
/**
 * valorPagado (opcional): permite registrar un monto distinto al planeado para esa cuota
 * (por ejemplo, si se pagó con un descuento o un poco de más). Si se indica, también queda
 * como el nuevo valor de la cuota en el plan de pagos. El abono queda enlazado a la cuota
 * (abonoId) para poder revertir el pago exacto más adelante con revertirCuotaPagada().
 */
async function marcarCuotaPagada(idPrestamo, numeroCuota, fecha, valorPagado) {
  const prestamo = await idb.obtenerPorId('prestamos', idPrestamo);
  if (!prestamo) throw new Error('Préstamo no encontrado.');
  const plan = Array.isArray(prestamo.Plan_Pagos) ? prestamo.Plan_Pagos : [];
  const cuota = plan.find((c) => c.numero === numeroCuota);
  if (!cuota) throw new Error('No se encontró esa cuota en el plan de pagos.');
  if (cuota.pagada) throw new Error('Esa cuota ya estaba marcada como pagada.');

  const fechaPago = fecha || hoyISO();
  const valor = (valorPagado !== undefined && valorPagado !== null && valorPagado !== '')
    ? round2(Number(valorPagado)) : Number(cuota.valor);
  if (!valor || valor <= 0) throw new Error('El valor pagado debe ser mayor a cero.');

  const abonosPrevios = await obtenerAbonosPorPrestamo(idPrestamo);
  const { saldo: saldoPrevio } = _totalVigenteYSaldo(prestamo, abonosPrevios);
  const nuevoSaldo = round2(saldoPrevio - valor);
  if (nuevoSaldo < -0.01) {
    throw new Error('El valor pagado excede el saldo pendiente (saldo actual: ' + saldoPrevio + ').');
  }

  const abono = {
    id: generarId('ABO'),
    ID_Prestamo: idPrestamo,
    Fecha_Abono: fechaPago,
    Valor_Abono: valor,
    Nota: 'Pago de la cuota ' + numeroCuota + ' del plan de pagos',
    Fecha_Registro: hoyISO(),
    updatedAt: nowISO(),
    deleted: false
  };
  await idb.guardar('abonos', abono);

  prestamo.Plan_Pagos = plan.map((c) =>
    c.numero === numeroCuota
      ? Object.assign({}, c, { valor: valor, pagada: true, fechaPagoReal: fechaPago, abonoId: abono.id })
      : c
  );
  prestamo.updatedAt = nowISO();
  await idb.guardar('prestamos', prestamo);
  return obtenerPrestamo(idPrestamo);
}

/** Deshace marcarCuotaPagada(): elimina el abono que se había registrado para esa cuota
 * (borrado suave, igual que el resto de la app) y la deja pendiente otra vez. */
async function revertirCuotaPagada(idPrestamo, numeroCuota) {
  const prestamo = await idb.obtenerPorId('prestamos', idPrestamo);
  if (!prestamo) throw new Error('Préstamo no encontrado.');
  const plan = Array.isArray(prestamo.Plan_Pagos) ? prestamo.Plan_Pagos : [];
  const cuota = plan.find((c) => c.numero === numeroCuota);
  if (!cuota) throw new Error('No se encontró esa cuota en el plan de pagos.');
  if (!cuota.pagada) throw new Error('Esa cuota no está marcada como pagada.');

  if (cuota.abonoId) {
    const abono = await idb.obtenerPorId('abonos', cuota.abonoId);
    if (abono) {
      abono.deleted = true;
      abono.updatedAt = nowISO();
      await idb.guardar('abonos', abono);
    }
  }

  prestamo.Plan_Pagos = plan.map((c) =>
    c.numero === numeroCuota ? Object.assign({}, c, { pagada: false, fechaPagoReal: null, abonoId: null }) : c
  );
  prestamo.updatedAt = nowISO();
  await idb.guardar('prestamos', prestamo);
  return obtenerPrestamo(idPrestamo);
}

// -------------------------------------------------------------------------
// RETANQUEO — se recibe un abono (opcional) y se presta más dinero, extendiendo el plazo
// -------------------------------------------------------------------------

/**
 * datos: { Fecha, ValorAbono (opcional, >=0), MontoAdicional (obligatorio, >0),
 *          Porcentaje_Seguro, Porcentaje_Interes, Monto_A_Pagar_Nuevo (opcional, override
 *          manual — igual que en crearPrestamo, si se indica se recalcula el interés),
 *          Nueva_Fecha_Pago (obligatoria), Nota }
 */
async function retanquearPrestamo(idPrestamo, datos) {
  const prestamo = await idb.obtenerPorId('prestamos', idPrestamo);
  if (!prestamo) throw new Error('Préstamo no encontrado.');
  if (prestamo.estadoManual === ESTADOS.CANCELADO) throw new Error('Este préstamo está cancelado y no se puede retanquear.');

  const montoAdicional = Number(datos.MontoAdicional);
  if (!montoAdicional || montoAdicional <= 0) throw new Error('El monto adicional debe ser mayor a cero.');
  if (!datos.Nueva_Fecha_Pago) throw new Error('Debes indicar la nueva fecha de pago.');

  // 1) Si el cliente abona algo primero, se registra como un abono normal contra el préstamo actual.
  if (datos.ValorAbono && Number(datos.ValorAbono) > 0) {
    await registrarAbono(idPrestamo, datos.Fecha || hoyISO(), datos.ValorAbono, 'Abono previo a retanqueo' + (datos.Nota ? ' — ' + datos.Nota : ''));
  }

  const prestamoActualizado = await idb.obtenerPorId('prestamos', idPrestamo);
  const abonos = await obtenerAbonosPorPrestamo(idPrestamo);
  const { saldo: saldoAntes } = _totalVigenteYSaldo(prestamoActualizado, abonos);
  if (saldoAntes < 0) throw new Error('El saldo antes del retanqueo no puede ser negativo.');

  const config = await getConfig();
  const pSeguro = (datos.Porcentaje_Seguro === undefined || datos.Porcentaje_Seguro === '' || datos.Porcentaje_Seguro === null) ? config.seguro : Number(datos.Porcentaje_Seguro);
  const valorSeguroAdicional = round2(montoAdicional * (pSeguro / 100));
  const montoEntregadoAdicional = round2(montoAdicional - valorSeguroAdicional);

  let valorInteresAdicional, pInteres, montoAPagarNuevo;
  if (datos.Monto_A_Pagar_Nuevo !== undefined && datos.Monto_A_Pagar_Nuevo !== '' && datos.Monto_A_Pagar_Nuevo !== null) {
    montoAPagarNuevo = round2(Number(datos.Monto_A_Pagar_Nuevo));
    valorInteresAdicional = round2(montoAPagarNuevo - saldoAntes - montoAdicional);
    pInteres = montoAdicional > 0 ? round2((valorInteresAdicional / montoAdicional) * 100) : 0;
  } else {
    pInteres = (datos.Porcentaje_Interes === undefined || datos.Porcentaje_Interes === '' || datos.Porcentaje_Interes === null) ? config.interes : Number(datos.Porcentaje_Interes);
    valorInteresAdicional = round2(montoAdicional * (pInteres / 100));
    montoAPagarNuevo = round2(saldoAntes + montoAdicional + valorInteresAdicional);
  }

  const fechaHoraRetanqueo = nowISO();
  const evento = {
    fecha: hoyISO(), fechaHora: fechaHoraRetanqueo,
    saldoAntes, montoAdicional, porcentajeSeguro: pSeguro, valorSeguroAdicional, montoEntregadoAdicional,
    porcentajeInteres: pInteres, valorInteresAdicional, montoAPagarNuevo,
    fechaPagoAnterior: prestamoActualizado.Fecha_Pago, fechaPagoNueva: datos.Nueva_Fecha_Pago,
    nota: datos.Nota || ''
  };

  prestamoActualizado.Monto_Prestado = round2(Number(prestamoActualizado.Monto_Prestado) + montoAdicional);
  prestamoActualizado.Valor_Seguro = round2(Number(prestamoActualizado.Valor_Seguro) + valorSeguroAdicional);
  prestamoActualizado.Monto_Entregado = round2(Number(prestamoActualizado.Monto_Entregado) + montoEntregadoAdicional);
  prestamoActualizado.Valor_Interes = round2(Number(prestamoActualizado.Valor_Interes) + valorInteresAdicional);
  prestamoActualizado.Monto_A_Pagar = montoAPagarNuevo;
  prestamoActualizado.Fecha_Pago = datos.Nueva_Fecha_Pago;
  prestamoActualizado.Fecha_Ultimo_Retanqueo = fechaHoraRetanqueo;
  prestamoActualizado.estadoManual = null; // un retanqueo reactiva el préstamo si estaba marcado distinto
  prestamoActualizado.Historial_Retanqueos = (prestamoActualizado.Historial_Retanqueos || []).concat([evento]);
  prestamoActualizado.updatedAt = nowISO();

  await idb.guardar('prestamos', prestamoActualizado);
  return obtenerPrestamo(idPrestamo);
}

// -------------------------------------------------------------------------
// CAPITAL — plante inicial + inyecciones de capital (propias o de inversionistas)
// -------------------------------------------------------------------------

const TIPOS_CAPITAL = { PROPIO: 'Propio', INVERSIONISTA: 'Inversionista' };

async function listarCapital() {
  const todos = await idb.obtenerTodos('capital');
  return todos.filter((c) => !c.deleted).sort((a, b) => String(b.Fecha).localeCompare(String(a.Fecha)) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** datos: { Fecha, Monto, Tipo ('Propio'|'Inversionista'), Inversionista (obligatorio si Tipo=Inversionista), Nota }. */
async function registrarCapital(datos) {
  const monto = Number(datos.Monto);
  if (!monto || monto <= 0) throw new Error('El monto de la inyección de capital debe ser mayor a cero.');
  const tipo = datos.Tipo === TIPOS_CAPITAL.INVERSIONISTA ? TIPOS_CAPITAL.INVERSIONISTA : TIPOS_CAPITAL.PROPIO;
  const inversionista = tipo === TIPOS_CAPITAL.INVERSIONISTA ? String(datos.Inversionista || '').trim() : '';
  if (tipo === TIPOS_CAPITAL.INVERSIONISTA && !inversionista) {
    throw new Error('Debes indicar el nombre del inversionista.');
  }

  const capital = {
    id: generarId('CAP'),
    Fecha: datos.Fecha || hoyISO(),
    Monto: monto,
    Tipo: tipo,
    Inversionista: inversionista,
    Nota: datos.Nota || '',
    Fecha_Registro: hoyISO(),
    updatedAt: nowISO(),
    deleted: false
  };
  await idb.guardar('capital', capital);
  return capital;
}

/** datos: igual que registrarCapital, pero editando un registro existente (corrige un
 * error de digitación, por ejemplo). */
async function actualizarCapital(id, datos) {
  const actual = await idb.obtenerPorId('capital', id);
  if (!actual) throw new Error('Inyección de capital no encontrada.');

  const monto = datos.Monto !== undefined ? Number(datos.Monto) : actual.Monto;
  if (!monto || monto <= 0) throw new Error('El monto de la inyección de capital debe ser mayor a cero.');

  const tipo = datos.Tipo !== undefined
    ? (datos.Tipo === TIPOS_CAPITAL.INVERSIONISTA ? TIPOS_CAPITAL.INVERSIONISTA : TIPOS_CAPITAL.PROPIO)
    : actual.Tipo;
  const inversionista = tipo === TIPOS_CAPITAL.INVERSIONISTA
    ? String((datos.Inversionista !== undefined ? datos.Inversionista : actual.Inversionista) || '').trim()
    : '';
  if (tipo === TIPOS_CAPITAL.INVERSIONISTA && !inversionista) {
    throw new Error('Debes indicar el nombre del inversionista.');
  }

  if (datos.Fecha !== undefined) actual.Fecha = datos.Fecha;
  actual.Monto = monto;
  actual.Tipo = tipo;
  actual.Inversionista = inversionista;
  if (datos.Nota !== undefined) actual.Nota = datos.Nota;
  actual.updatedAt = nowISO();
  await idb.guardar('capital', actual);
  return actual;
}

async function eliminarCapital(id) {
  const actual = await idb.obtenerPorId('capital', id);
  if (!actual) throw new Error('Inyección de capital no encontrada.');
  actual.deleted = true;
  actual.updatedAt = nowISO();
  await idb.guardar('capital', actual);
  return true;
}

/** Nombres de inversionistas ya usados alguna vez, para sugerirlos (autocompletar) sin obligar a un catálogo aparte. */
async function listarInversionistasUsados() {
  const todos = await listarCapital();
  const set = new Set(todos.filter((c) => c.Tipo === TIPOS_CAPITAL.INVERSIONISTA && c.Inversionista).map((c) => c.Inversionista));
  return Array.from(set).sort();
}

/** Resumen del capital de trabajo: plante inicial + todas las inyecciones, desglosado por origen. */
async function obtenerResumenCapital() {
  const config = await getConfig();
  const inyecciones = await listarCapital();

  let totalPropio = 0, totalInversionistas = 0;
  const porInversionista = {};
  inyecciones.forEach((c) => {
    if (c.Tipo === TIPOS_CAPITAL.INVERSIONISTA) {
      totalInversionistas += Number(c.Monto || 0);
      porInversionista[c.Inversionista] = round2((porInversionista[c.Inversionista] || 0) + Number(c.Monto || 0));
    } else {
      totalPropio += Number(c.Monto || 0);
    }
  });

  const capitalInicial = round2(Number(config.capitalInicial || 0));
  const totalInyectado = round2(totalPropio + totalInversionistas);

  return {
    capitalInicial,
    totalInyectado,
    totalPropio: round2(totalPropio),
    totalInversionistas: round2(totalInversionistas),
    capitalTotal: round2(capitalInicial + totalInyectado),
    porInversionista,
    inyecciones,
    moneda: config.moneda
  };
}

// -------------------------------------------------------------------------
// DASHBOARD
// -------------------------------------------------------------------------

/** filtro = { idCliente, fechaInicio, fechaFin } — todos opcionales. */
/** filtro: { idCliente, idRuta, idCobrador, fechaInicio, fechaFin }. */
async function obtenerDashboard(filtro) {
  filtro = filtro || {};
  let prestamos = (await idb.obtenerTodos('prestamos')).filter((p) => !p.deleted);
  const abonosTodos = (await idb.obtenerTodos('abonos')).filter((a) => !a.deleted);

  if (filtro.idCliente) prestamos = prestamos.filter((p) => String(p.ID_Cliente) === String(filtro.idCliente));

  if (filtro.idRuta || filtro.idCobrador) {
    let clientesPermitidos = await listarClientes();
    if (filtro.idRuta) clientesPermitidos = clientesPermitidos.filter((c) => c.ID_Ruta === filtro.idRuta);
    if (filtro.idCobrador) {
      const rutas = await listarRutas();
      const idsRutas = new Set(rutas.filter((r) => r.ID_Cobrador === filtro.idCobrador).map((r) => r.id));
      clientesPermitidos = clientesPermitidos.filter((c) => idsRutas.has(c.ID_Ruta));
    }
    const idsClientes = new Set(clientesPermitidos.map((c) => c.id));
    prestamos = prestamos.filter((p) => idsClientes.has(p.ID_Cliente));
  }

  if (filtro.fechaInicio) {
    const desde = parseFecha(filtro.fechaInicio);
    prestamos = prestamos.filter((p) => parseFecha(p.Fecha_Prestamo) >= desde);
  }
  if (filtro.fechaFin) {
    const hasta = parseFecha(filtro.fechaFin);
    prestamos = prestamos.filter((p) => parseFecha(p.Fecha_Prestamo) <= hasta);
  }

  const idsFiltrados = new Set(prestamos.map((p) => p.id));
  const abonosFiltrados = abonosTodos.filter((a) => idsFiltrados.has(a.ID_Prestamo));

  let totalPrestado = 0, totalSeguro = 0, totalInteres = 0, totalAPagar = 0, totalRecaudadoVigente = 0;
  const porEstado = { Activo: 0, Pagado: 0, Mora: 0, Cancelado: 0 };

  prestamos.forEach((p) => {
    const abonosPrestamo = abonosFiltrados.filter((a) => String(a.ID_Prestamo) === String(p.id));
    const { totalVigente, saldo } = _totalVigenteYSaldo(p, abonosPrestamo);
    const estado = calcularEstado(p, saldo);

    totalPrestado += Number(p.Monto_Prestado || 0);
    totalSeguro += Number(p.Valor_Seguro || 0);
    totalInteres += Number(p.Valor_Interes || 0);
    totalAPagar += Number(p.Monto_A_Pagar || 0);
    totalRecaudadoVigente += totalVigente;
    porEstado[estado] = (porEstado[estado] || 0) + 1;
  });

  // "Total recaudado" es el efectivo bruto recibido (todos los abonos, incluidos los que
  // quedaron absorbidos por un retanqueo); la cartera pendiente en cambio se calcula con
  // los saldos vigentes de cada préstamo (ver _totalVigenteYSaldo), que es lo correcto
  // para saber cuánto falta por cobrar hoy.
  const totalRecaudadoBruto = abonosFiltrados.reduce((s, a) => s + Number(a.Valor_Abono || 0), 0);
  const config = await getConfig();

  return {
    totalCreditos: prestamos.length,
    totalPrestado: round2(totalPrestado),
    totalSeguro: round2(totalSeguro),
    totalInteres: round2(totalInteres),
    totalAPagar: round2(totalAPagar),
    totalRecaudado: round2(totalRecaudadoBruto),
    carteraPendiente: round2(totalAPagar - totalRecaudadoVigente),
    porEstado,
    moneda: config.moneda
  };
}

window.logic = {
  ESTADOS, TIPOS_CAPITAL, nowISO, hoyISO, round2, generarId, fusionarColeccion, fusionarConfig,
  getConfig, guardarConfig,
  CORREOS_RESPALDO, listarCorreosAutorizados, agregarCorreoAutorizado, quitarCorreoAutorizado, estaCorreoAutorizado,
  listarClientes, buscarClientes, listarClientesPaginado, listarCiudadesUsadas,
  obtenerCliente, crearCliente, actualizarCliente,
  listarRutas, obtenerRuta, crearRuta, actualizarRuta, contarClientesPorRuta,
  listarCobradores, obtenerCobrador, obtenerCobradorPorCorreo, crearCobrador, actualizarCobrador, listarRutasPorCobrador,
  calcularSugerido, crearPrestamo, actualizarPrestamo, actualizarEstadoManual, obtenerPrestamo,
  obtenerPrestamosPorCliente, listarPrestamosPorClientePaginado, obtenerHistorialCliente, obtenerAbonosPorPrestamo,
  registrarAbono, marcarCuotaPagada, revertirCuotaPagada, retanquearPrestamo, obtenerDashboard,
  listarCapital, registrarCapital, actualizarCapital, eliminarCapital, listarInversionistasUsados, obtenerResumenCapital
};
