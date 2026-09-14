# App de Gestión de Préstamos (instalable, con base de datos local + Firebase)

## Qué es esta app

Es una aplicación web "instalable" (PWA — Progressive Web App), ya publicada en
`https://app-prestamos-38dd6.web.app`, que:

- Se instala en tu **portátil** y tu **celular** como una app normal (ícono propio, se
  abre en su propia ventana, sin barra del navegador).
- Guarda los datos **primero en el propio dispositivo** (una base de datos NoSQL local
  llamada IndexedDB), así que funciona **sin internet** — puedes buscar clientes,
  registrar préstamos y abonos aunque no haya señal.
- Cuando hay conexión, **sincroniza automáticamente** con **Firebase** — el mismo
  proyecto donde ya está publicada la app (`app-prestamos-38dd6`) — guardando todos los
  datos en un documento de **Cloud Firestore**. Si usas el portátil y el celular con la
  misma cuenta autorizada, los dos quedan sincronizados entre sí.
- **Pide iniciar sesión con Google** antes de mostrar nada: solo las cuentas que agregues
  a la lista blanca (⚙️ Configuración → 🔒 Acceso a la app) pueden entrar, en cualquier
  dispositivo. La misma sesión con la que entras sirve también para sincronizar — no hay
  un segundo permiso aparte que pedir.
- La navegación es de **lista paginada → detalle**: entras a "Clientes" y ves una lista
  paginada (10/20/50 por página) con filtros de ciudad, ruta y cobrador; al abrir un
  cliente ves sus préstamos (el más reciente primero, también paginados, con filtro de
  estado); al abrir un préstamo ves sus abonos, puedes registrar uno nuevo y el saldo se
  actualiza automáticamente, y puedes **retanquearlo** (recibir un abono y prestar más,
  extendiendo el plazo) sin perder el historial.

Si en algún punto se te complica algún paso, dime en cuál quedaste y seguimos juntos.

---

## Parte 1 — Publicar los archivos (ya hecho, para referencia futura)

Tu app ya está publicada en Firebase Hosting. Estos pasos solo los necesitas si algún día
tienes que volver a publicarla desde cero (por ejemplo, en un proyecto nuevo):

1. Instala [Node.js](https://nodejs.org) si no lo tienes.
2. En una terminal, dentro de la carpeta con todos estos archivos (la que contiene
   `firebase.json` y la carpeta `public/`):
   ```
   npm install -g firebase-tools
   firebase login
   firebase deploy
   ```
3. Te dará la URL pública (`https://app-prestamos-38dd6.web.app`).

Cuando te entregue una actualización de la app, este paso (`firebase deploy` dentro de la
carpeta que te envíe) es lo único que tienes que repetir para que los cambios queden
publicados.

---

## Parte 2 — Configurar Firebase (Authentication + Firestore)

Esto es lo que reemplaza a Google Drive: en vez de pedir un permiso aparte para Drive
(con "Usuarios de prueba", carpetas compartidas, etc.), ahora el mismo inicio de sesión
de la app sirve para guardar los datos, y tú controlas quién entra desde dos lugares
distintos que se complementan: **Firebase Authentication** decide quién puede *iniciar
sesión de forma verificada*, y las **Reglas de seguridad de Firestore** deciden quién
puede *leer o escribir los datos* una vez adentro.

### 2.1 — Activar el inicio de sesión con Google

1. Ve a [console.firebase.google.com](https://console.firebase.google.com) y entra al
   proyecto **app-prestamos-38dd6** (el mismo del Hosting).
2. En el menú de la izquierda, ve a **Authentication** → pestaña **Sign-in method**
   (Método de acceso).
3. Haz clic en **Google** dentro de la lista de proveedores, actívalo (interruptor
   arriba a la derecha del panel), elige un correo de soporte del proyecto, y guarda.
4. En la pestaña **Settings → Authorized domains** (Dominios autorizados), confirma que
   `app-prestamos-38dd6.web.app` (y `app-prestamos-38dd6.firebaseapp.com`) ya aparezcan en
   la lista — como es el mismo proyecto del Hosting, normalmente ya están ahí por
   defecto. Si más adelante usas un dominio propio (por ejemplo `prestamos.tunegocio.com`),
   agrégalo aquí también, o el inicio de sesión no funcionará desde esa dirección.

### 2.2 — Crear la base de datos (Cloud Firestore)

1. En el menú de la izquierda, ve a **Firestore Database** → **Crear base de datos**.
2. Elige **modo producción** (no "modo de prueba" — vamos a pegar nuestras propias
   reglas en el siguiente paso, así que no hace falta el modo de prueba abierto).
3. Elige la ubicación del servidor más cercana (por ejemplo, una región de EE. UU. o
   Sudamérica si está disponible) y confirma. Esto tarda uno o dos minutos.

### 2.3 — Pegar las reglas de seguridad

Sin este paso, Firestore queda cerrado por defecto (nadie puede sincronizar) o, si
dejaste el modo de prueba, completamente abierto (cualquiera con el enlace podría leer o
borrar tus datos) — así que **no te saltes este paso**.

1. Dentro de **Firestore Database**, ve a la pestaña **Reglas** (Rules).
2. Borra lo que haya y pega exactamente esto:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {

       function esRespaldo() {
         return ['csilva0725@gmail.com', 'sergiosamir330@gmail.com']
           .hasAny([request.auth.token.email.lower()]);
       }

       function correoAutorizado() {
         return esRespaldo() ||
           (resource.data.config != null &&
            resource.data.config.correosAutorizados != null &&
            resource.data.config.correosAutorizados.hasAny([request.auth.token.email.lower()]));
       }

       match /sync/maestro {
         allow get: if request.auth != null && correoAutorizado();
         allow update: if request.auth != null && correoAutorizado();
         allow create: if request.auth != null && esRespaldo();
         allow delete: if false;
       }
     }
   }
   ```
3. Haz clic en **Publicar** (Publish).

Esto dice: solo alguien que inició sesión (`request.auth != null`) y cuyo correo está en
la lista blanca de la app (o es una de las dos cuentas de respaldo) puede leer o
actualizar el documento de datos; nadie puede borrarlo desde fuera de la app.

> Este mismo texto ya viene guardado en el archivo `firestore.rules` de esta entrega, por
> si prefieres pegarlo con la terminal en vez de la consola web:
> `firebase deploy --only firestore:rules`.
>
> Si en algún momento cambias las cuentas de respaldo en `public/js/config-local.js`
> (`CORREOS_RESPALDO`), actualiza también esta misma lista aquí para que coincidan.

### 2.4 — Copiar la configuración del proyecto a la app

Tanto la configuración de Firebase como las cuentas de respaldo viven en un único
archivo, `public/js/config-local.js` — separado a propósito del resto del código, para
que cuando te entregue una actualización de la app **no tengas que volver a pegar nada
aquí**: solo reemplazas los demás archivos y conservas este tal como lo dejaste.

1. En Firebase Console, haz clic en el ícono de engranaje (⚙️) junto a "Project Overview"
   → **Configuración del proyecto**.
2. Baja hasta **"Tus apps"**. Si ya existe una app web, haz clic en ella; si no, haz clic
   en el ícono `</>` para crear una (nombre: "Gestión de Préstamos", no hace falta marcar
   Firebase Hosting en ese asistente porque ya lo tienes configurado).
3. Copia el objeto `firebaseConfig` que te muestra, algo así:
   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "app-prestamos-38dd6.firebaseapp.com",
     projectId: "app-prestamos-38dd6",
     storageBucket: "app-prestamos-38dd6.appspot.com",
     messagingSenderId: "...",
     appId: "..."
   };
   ```
4. Abre el archivo `public/js/config-local.js` de esta entrega y busca, cerca del
   inicio:
   ```js
   const FIREBASE_CONFIG = {
     apiKey: 'TU_API_KEY_AQUI',
     authDomain: 'TU_PROYECTO.firebaseapp.com',
     projectId: 'TU_PROYECTO',
     storageBucket: 'TU_PROYECTO.appspot.com',
     messagingSenderId: 'TU_SENDER_ID',
     appId: 'TU_APP_ID'
   };
   ```
5. Reemplaza esos seis valores por los que copiaste (mantén las comillas).
6. Publica de nuevo (`firebase deploy`).

> **Nota:** de ahora en adelante te entregaré solo los archivos que realmente cambien en
> cada actualización — como `config-local.js` casi nunca va a estar entre ellos (a menos
> que cambie algo de tu configuración de Firebase o tus cuentas de respaldo), tu
> configuración real queda a salvo sin que tengas que repetir este paso cada vez. Si
> alguna vez recibes el paquete completo del proyecto (por ejemplo, para una instalación
> nueva), ahí sí trae los valores de ejemplo — solo en ese caso hay que repetir este paso,
> o la app se quedará mostrando "Falta configurar FIREBASE_CONFIG..." en la pantalla de
> acceso.

Con esto, ya no hace falta nada de lo que antes se hacía en Google Cloud Console
(pantalla de consentimiento de OAuth, "Usuarios de prueba", ni compartir carpetas de
Drive a mano con cada cobrador) — todo eso quedó reemplazado por estos cuatro pasos, que
solo se hacen una vez.

---

## Acceso a la app (lista blanca)

1. Entra a la app con tu cuenta de Google (una de las dos de respaldo,
   `csilva0725@gmail.com` o `sergiosamir330@gmail.com`, siempre puede entrar).
2. Ve a **⚙️ Configuración → 🔒 Acceso a la app**.
3. Ahí agregas o quitas los correos de Google que pueden iniciar sesión en la app, desde
   cualquier dispositivo. Las dos cuentas de respaldo siempre tienen acceso, aunque las
   quites de la lista, para que nunca queden bloqueadas.
4. Esta lista se sincroniza con Firestore junto con el resto de tus datos — si
   sincronizas el portátil y el celular con la misma cuenta, los correos que agregues
   aquí quedan disponibles en ambos dispositivos.

Si alguien intenta entrar con una cuenta que no está en esta lista, la app le muestra un
mensaje y no lo deja pasar (cierra esa sesión automáticamente).

---

## Rutas y cobradores (organización) y qué ve cada cobrador

- En **🛣️ Rutas** creas las zonas o barrios por donde cobras (por ejemplo, "Cúcuta
  Centro"), y le puedes asignar un cobrador. Un cobrador puede tener varias rutas.
- En **🧑‍💼 Cobradores** registras a las personas que cobran por ti: nombre, correo y
  teléfono.
- Al crear o editar un cliente, le asignas una ruta (selector "Ruta"). Eso te permite
  filtrar la lista de clientes y el Dashboard por ruta o por cobrador, para saber
  rápidamente qué le corresponde cobrar a cada quien.

**El correo del cobrador controla lo que ve dentro de la app.** Cuando alguien inicia
sesión con un correo que coincide exactamente con el "Correo" de un cobrador registrado,
la app le muestra **solo** la pestaña Clientes, y dentro de ella **solo** los clientes de
la(s) ruta(s) que le asignaste a ese cobrador — no ve Dashboard, Rutas, Cobradores ni
Configuración, ni los clientes de otras rutas. Tú (con tu correo de respaldo) siempre ves
todo, sin excepción.

Para darle esto a un cobrador, hacen falta **dos pasos** (los dos son necesarios, uno no
reemplaza al otro):

1. **Que pueda iniciar sesión:** agrega su correo en ⚙️ Configuración → 🔒 Acceso a la
   app (esto solo controla si puede entrar a la app, no qué ve una vez adentro).
2. **Que solo vea su ruta:** en 🧑‍💼 Cobradores, registra (o edita) su ficha con el
   **mismo correo exacto** con el que va a iniciar sesión, y asígnale su ruta en
   🛣️ Rutas.

Si le das acceso (paso 1) pero no lo registras como cobrador con ese correo (paso 2),
entra a la app y ve **todo**, igual que tú — así que si quieres que un cobrador quede
limitado a su ruta, no olvides el paso 2.

A diferencia de la versión anterior con Google Drive, **ya no hace falta compartir
ninguna carpeta a mano**: en cuanto el correo del cobrador está en la lista blanca (paso
1), las Reglas de seguridad de Firestore (Parte 2.3) ya lo dejan sincronizar contra el
mismo documento que usas tú — el paso 2 solo decide qué ve *dentro* de la app, no si
puede sincronizar.

> **Nota sobre seguridad:** la restricción de qué ve cada cobrador (paso 2, solo su
> ruta) vive en el código que corre en su navegador, no en el servidor — es un control
> honesto para el uso normal de la app (evita que un cobrador vea o edite por accidente
> los datos de otra ruta), pero alguien con conocimientos técnicos y muchas ganas podría,
> en teoría, saltársela desde las herramientas de desarrollador del navegador. El acceso
> mismo a la app y a los datos (paso 1) sí queda protegido del lado del servidor, por
> Firebase Authentication y las Reglas de Firestore. Comparte el acceso solo con
> cobradores de confianza.

---

## Parte 3 — Instalar la app en el portátil y en el celular

### En el portátil (Windows o Mac, con Chrome o Edge)

1. Abre `https://app-prestamos-38dd6.web.app`.
2. En la barra de direcciones aparece un ícono de instalar (una pantallita con una
   flecha, o "Instalar app"), o puedes usar el menú ⋮ → **Instalar Gestión de
   Préstamos**.
3. Acepta. Quedará como una app aparte, con su propio ícono, en tu portátil.

### En el celular

- **Android (Chrome):** abre la URL, toca el menú ⋮ → **Instalar app** o **Añadir a
  pantalla de inicio**.
- **iPhone (Safari):** abre la URL, toca el ícono de compartir (el cuadrado con la
  flecha hacia arriba) → **Añadir a pantalla de inicio**. En iPhone la instalación es
  manual (Apple no permite el botón automático), pero funciona igual de bien.

### Primer uso

1. Abre la app instalada: te pedirá iniciar sesión con Google. Usa una cuenta que ya
   esté en la lista blanca (al principio, una de las dos cuentas de respaldo).
2. Después de iniciar sesión, la app sincroniza sola contra Firestore (al abrir la app,
   al recuperar internet, y cada minuto) — no hay que conectar nada aparte, como antes
   pasaba con Google Drive. También puedes pulsar **Sincronizar ahora** en el
   encabezado o en ⚙️ Configuración para forzarlo al momento.
3. Usa la **misma cuenta** en el portátil y en el celular para que ambos sincronicen
   contra los mismos datos.

Desde ese momento, la barra superior de la app muestra el estado: "Sincronizando…",
"Sincronizado a las…", "Sin conexión — cambios guardados localmente" o "Sesión expirada
— vuelve a entrar para sincronizar".

---

## Cómo funciona por dentro (para que sepas qué esperar)

- **Cada registro (cliente, préstamo, abono) se guarda primero en el dispositivo**, al
  instante, sin esperar internet.
- Cuando hay conexión, la app baja el documento de Firestore (`sync/maestro`), lo
  combina con lo que tienes localmente y sube el resultado combinado — así ambos
  dispositivos quedan iguales.
- Si el portátil y el celular editan **el mismo registro** mientras ambos están sin
  internet, al reconectar gana el cambio más reciente (por fecha/hora exacta). Esto es
  intencional y muy simple de entender, pero significa que no hay una pantalla de
  "resolver conflicto" — si te preocupa un caso así, dímelo y puedo agregar un aviso o
  un historial de cambios.
- Los **IDs** de cliente/préstamo/abono (por ejemplo `CLI-A1B2C3D4E5`) se generan de
  forma aleatoria en cada dispositivo para que nunca choquen entre sí, aunque se creen
  registros al mismo tiempo sin conexión.
- Puedes ver el documento crudo desde Firebase Console → Firestore Database →
  colección `sync` → documento `maestro`, si alguna vez quieres revisar los datos tal
  como quedan guardados.
- **Retanquear un préstamo** no crea un préstamo nuevo: actualiza el mismo registro
  (suma el monto adicional al monto prestado, al seguro y al interés acumulados, y
  reemplaza el monto a pagar y la fecha de pago por los nuevos). Los abonos que ya se
  habían hecho antes del retanqueo se conservan en el historial para que siempre puedas
  ver el detalle completo, pero solo los abonos posteriores al retanqueo cuentan para el
  saldo pendiente vigente — así el saldo nunca queda mal calculado.
- El **Dashboard** distingue "Total recaudado" (todo el efectivo que has recibido en
  abonos, histórico) de "Cartera pendiente" (lo que falta por cobrar hoy, ya con los
  retanqueos aplicados) — son dos números distintos a propósito.
- En **⚙️ Configuración** puedes indicar el **plante inicial** (el capital con el que
  arrancó el negocio) y, aparte, ir registrando **inyecciones de capital** a medida que
  metas más dinero: cada una queda en un historial con su fecha, su monto y si es
  **recursos propios** o de un **inversionista** (indicando su nombre — la app te lo
  sugiere después de la primera vez que lo escribas, para que no te queden nombres
  distintos por un error de tipeo). Ahí mismo ves el capital total y el desglose por
  cada inversionista.
- El límite de tamaño de un documento de Firestore es 1 MB — de sobra para un negocio
  pequeño o mediano (miles de registros), pero si algún día el archivo crece muchísimo
  (decenas de miles de clientes/préstamos/abonos juntos), habría que repartir los datos
  en varios documentos. Avísame si llegas a ese punto y lo ajustamos.

## Actualizar la app más adelante

Como son archivos estáticos, cualquier cambio que te ayude a hacer requiere volver a
correr `firebase deploy` dentro de la carpeta con los archivos actualizados. El Service
Worker (`sw.js`) se encarga de que la próxima vez que abras la app, tome la versión
nueva automáticamente. Cada actualización solo trae los archivos que realmente cambiaron
— `public/js/config-local.js` (tu configuración de Firebase y tus cuentas de respaldo)
no se toca a menos que ese cambio sea justamente sobre eso, así que normalmente no hace
falta repetir el paso 2.4.

## Siguientes pasos opcionales

Con gusto puedo ayudarte después con: un historial/bitácora de cambios por registro
(útil si el conflicto "gana el más reciente" te preocupa), notificaciones de mora,
exportar un respaldo en Excel, o restructurar los datos en varios documentos de
Firestore si el negocio crece mucho.
