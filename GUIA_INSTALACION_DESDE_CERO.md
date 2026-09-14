# Guía de instalación desde cero (cuenta de Google y proyecto de Firebase nuevos)

Esta guía es para instalar la app en un computador **totalmente distinto**, usando una
**cuenta de Google** y un **proyecto de Firebase propios** — no la cuenta ni el proyecto
que usa Carlos (`app-prestamos-38dd6`). Sirve, por ejemplo, para dar la app a otro
negocio, o para tener una copia de prueba separada de la real.

Si en cambio solo quieres usar la MISMA app que ya está en
`https://app-prestamos-38dd6.web.app` desde otro dispositivo, no necesitas nada de esto:
solo entra a esa dirección con una cuenta de Google que ya esté en la lista blanca (ver
`INSTRUCCIONES.md`, sección "Acceso a la app").

Sigue los pasos en orden — cada uno depende del anterior. Al final tendrás una copia de
la app completamente independiente: sus propios datos, su propia lista de usuarios
autorizados y su propia dirección web.

---

## Lo que necesitas antes de empezar

- Una **cuenta de Google** (Gmail) para administrar el proyecto — puede ser cualquier
  cuenta, no hace falta que sea la del negocio.
- El computador donde vas a hacer la instalación, con [Node.js](https://nodejs.org)
  instalado (cualquier versión reciente sirve; el instalador de la página trae también
  `npm`, que se usa más adelante).
- Los archivos de la app (la carpeta `public/`, `firebase.json` y `firestore.rules`) que
  te entregué — descomprime el `.zip` en una carpeta de ese computador.

---

## Paso 1 — Crear el proyecto de Firebase

1. Entra a [console.firebase.google.com](https://console.firebase.google.com) con la
   cuenta de Google que vas a usar para este proyecto (puede ser una cuenta nueva,
   creada solo para esto).
2. Haz clic en **Crear un proyecto** (Add project).
3. Ponle un nombre (por ejemplo, "Préstamos Cliente Nuevo"). Firebase le agrega un
   identificador único automáticamente (algo como `prestamos-cliente-nuevo-a1b2c`) —
   ese identificador es el que vas a ver repetido en varias partes más adelante.
4. En el siguiente paso te pregunta por Google Analytics — puedes desactivarlo
   ("Disable Google Analytics for this project"), no hace falta para esta app.
5. Espera a que termine de crear el proyecto y entra a su panel.

---

## Paso 2 — Instalar las herramientas de Firebase y conectar el proyecto

1. Abre una terminal en el computador, dentro de la carpeta donde descomprimiste los
   archivos (la que contiene `firebase.json`).
2. Instala las herramientas de Firebase (una sola vez por computador):
   ```
   npm install -g firebase-tools
   ```
3. Inicia sesión con la cuenta de Google del Paso 1:
   ```
   firebase login
   ```
   Se abrirá una ventana del navegador para autorizar; acepta con esa misma cuenta.
4. Conecta esta carpeta con tu proyecto de Firebase:
   ```
   firebase use --add
   ```
   Elige de la lista el proyecto que creaste en el Paso 1, y cuando te pida un alias
   escribe `default`.

---

## Paso 3 — Activar el inicio de sesión con Google

1. En el panel de Firebase Console, ve a **Authentication** (menú de la izquierda) →
   **Get started** (si es la primera vez) → pestaña **Sign-in method**.
2. Haz clic en **Google** dentro de la lista de proveedores, actívalo, elige un correo
   de soporte del proyecto (puede ser la misma cuenta con la que entraste) y guarda.
3. En **Settings → Authorized domains** (Dominios autorizados) confirma que aparezcan
   `TU-PROYECTO.web.app` y `TU-PROYECTO.firebaseapp.com` (con el identificador de tu
   propio proyecto) — normalmente ya quedan agregados automáticamente en cuanto
   publiques el Hosting en el Paso 5.

---

## Paso 4 — Crear la base de datos (Cloud Firestore) y pegar las reglas

1. En el menú de la izquierda, ve a **Firestore Database** → **Crear base de datos**.
2. Deja el Database ID en **`(default)`**, elige **modo producción**, y elige la
   ubicación del servidor más cercana. Confirma (tarda uno o dos minutos).
3. Ve a la pestaña **Reglas** (Rules), borra lo que haya y pega el contenido completo
   del archivo `firestore.rules` que viene en esta entrega. Haz clic en **Publicar**.

   > **Importante:** ese archivo trae, escritas dentro, las dos "cuentas de respaldo"
   > de Carlos (`csilva0725@gmail.com` y `sergiosamir330@gmail.com`) — cuentas que
   > *siempre* pueden entrar y sincronizar, sin importar la lista blanca. Para esta
   > instalación nueva, **reemplaza esos dos correos por el/los tuyos** antes de
   > pegarlas (ver Paso 6 — deben coincidir exactamente con los que pongas en
   > `config-local.js`). Si dejas los correos de Carlos ahí, su cuenta también podría
   > entrar a esta copia nueva de la app.

---

## Paso 5 — Publicar la app (Hosting)

1. En la misma terminal del Paso 2:
   ```
   firebase deploy
   ```
2. Al terminar te muestra la URL pública, algo como
   `https://TU-PROYECTO.web.app` — esa es la dirección de tu app. Ábrela para
   confirmar que carga (verás la pantalla de acceso pidiendo iniciar sesión, aunque
   todavía no vaya a funcionar del todo — faltan los dos pasos siguientes).

---

## Paso 6 — Configurar `config-local.js` (cuentas de respaldo + configuración de Firebase)

Este archivo reúne todo lo específico de tu instalación en un solo lugar — separado a
propósito del resto del código — para que cuando más adelante te entregue una
actualización de la app **no tengas que volver a tocar esto**: solo reemplazas los demás
archivos y conservas este tal como lo dejaste.

### 6.1 — Cuentas de respaldo

Son las cuentas que **siempre** pueden entrar a la app y sincronizar, aunque se borren
por error de la lista blanca de Configuración — pensadas para que el dueño de *esta*
instalación nunca quede bloqueado de su propia app. Hay que definirlas en dos archivos,
y **deben coincidir exactamente** entre ellos:

1. Abre `public/js/config-local.js`, busca esta línea:
   ```js
   const CORREOS_RESPALDO = ['csilva0725@gmail.com', 'sergiosamir330@gmail.com'];
   ```
   Reemplaza esos correos por el tuyo (y, si quieres, uno de respaldo adicional, como
   un segundo dispositivo o un socio de confianza):
   ```js
   const CORREOS_RESPALDO = ['tu_correo@gmail.com'];
   ```
2. Abre `firestore.rules` (el mismo archivo que pegaste en el Paso 4) y cambia la lista
   dentro de `esRespaldo()` para que tenga **exactamente los mismos correos**:
   ```
   function esRespaldo() {
     return ['tu_correo@gmail.com'].hasAny([request.auth.token.email.lower()]);
   }
   ```
   Vuelve a pegar ese archivo actualizado en Firebase Console → Firestore Database →
   Reglas → Publicar (o corre `firebase deploy --only firestore:rules` desde la
   terminal).

Si estos dos archivos no coinciden, puede pasar que la app te deje "iniciar sesión"
pero Firestore rechace la sincronización (o al revés) — revisa que el correo esté
escrito igual en ambos lados (mismas mayúsculas/minúsculas no importa, la app y las
reglas lo comparan en minúsculas, pero sí debe ser la misma dirección).

### 6.2 — Configuración del proyecto de Firebase

1. En Firebase Console, haz clic en el ícono de engranaje (⚙️) junto a "Project
   Overview" → **Configuración del proyecto**.
2. Baja hasta **"Tus apps"** → haz clic en el ícono `</>` para crear una app web
   (nombre: lo que quieras, por ejemplo "Gestión de Préstamos"). No hace falta marcar
   la opción de Firebase Hosting en ese asistente, porque ya lo configuraste en el
   Paso 5.
3. Copia el objeto `firebaseConfig` que te muestra:
   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "TU-PROYECTO.firebaseapp.com",
     projectId: "TU-PROYECTO",
     storageBucket: "TU-PROYECTO.appspot.com",
     messagingSenderId: "...",
     appId: "..."
   };
   ```
4. En el mismo `public/js/config-local.js`, busca cerca del inicio:
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
6. Publica de nuevo:
   ```
   firebase deploy
   ```

---

## Paso 7 — Primer ingreso

1. Abre la URL de tu app (`https://TU-PROYECTO.web.app`) e inicia sesión con la cuenta
   de respaldo que pusiste en el Paso 6.
2. Ya puedes usar la app con datos totalmente independientes de los de Carlos: cada
   proyecto de Firebase tiene su propia base de datos, así que nada de lo que hagas
   aquí afecta la app de Carlos, ni al revés.
3. Ve a **⚙️ Configuración → 🔒 Acceso a la app** para agregar más correos autorizados
   (por ejemplo, cobradores) que podrán entrar desde cualquier dispositivo.
4. Para instalar la app en un portátil o celular, y para entender cómo funciona el
   resto de la app día a día (rutas, cobradores, sincronización, retanqueos), sigue
   las secciones correspondientes de `INSTRUCCIONES.md` — son las mismas explicaciones,
   solo que ahí las URLs y ejemplos usan el proyecto de Carlos; en tu instalación usa
   tu propia URL y tus propios correos.

---

## Resumen rápido (si ya hiciste esto antes)

```
firebase login
firebase use --add                      # elige el proyecto nuevo, alias "default"
# Firebase Console: activar Google en Authentication, crear Firestore (default, modo producción)
# Editar CORREOS_RESPALDO en public/js/config-local.js y esRespaldo() en firestore.rules (mismos correos)
firebase deploy --only firestore:rules
# Editar FIREBASE_CONFIG en public/js/config-local.js con los datos del proyecto nuevo
firebase deploy
```
