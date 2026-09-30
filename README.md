# livestock-manager-support-api

Backend de soporte con IA para Livestock Manager. Recibe incidencias desde la app, las estructura con IA, y crea issues en un repositorio de soporte dedicado vía GitHub App — sin exponer nunca credenciales al cliente.

Repo independiente de `LIVESTOCK-MANAGER` y `livestock-pwa-msix`: no comparte historial git ni build. El ciclo de vida completo de una incidencia está más abajo, en «Cómo funciona una incidencia».

## Stack

- **Runtime**: Cloudflare Workers
- **Almacenamiento**: Cloudflare KV (mapeo tickets) — migrar a D1 si se necesita consulta relacional más adelante
- **IA**: Workers AI (`env.AI`), modelo `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — sin API key propia ni proveedor externo
- **GitHub**: GitHub App (permisos `Issues: Read & Write` únicamente)
- **Verificación de compra**: Google Play Developer API (Android) y Microsoft Store
  Collection API vía Entra ID (Windows)

## Estructura del proyecto

```
livestock-manager-support-api/
├── src/
│   ├── index.ts                     # Entry point, router de rutas
│   ├── types.ts                     # Ticket, EstadoTicket, RANGO_ESTADO, Env
│   ├── routes/
│   │   ├── tickets.ts               # Alta, listado, detalle, /responder, /confirmar
│   │   ├── auth.ts                  # POST /auth/verify-purchase
│   │   └── webhooks.ts              # POST /webhooks/github
│   ├── services/
│   │   ├── ai.ts                    # Estructuración del reporte y respuesta del agente
│   │   ├── github.ts                # Auth de GitHub App, issues, etiquetas y apertura
│   │   ├── identidad.ts             # A quién pertenece la compra (adopción y enlace)
│   │   ├── playBilling.ts           # Verificación de compra Google Play
│   │   ├── msStoreBilling.ts        # Verificación de compra Microsoft Store (Entra ID)
│   │   └── storage.ts               # Lectura/escritura en KV
│   ├── middleware/
│   │   ├── auth.ts                  # Validación de JWT de sesión
│   │   └── rateLimit.ts             # Límite de tickets por usuario/día
│   └── utils/
│       ├── agente.ts                # Marcadores de comentario y textos del agente
│       ├── errores.ts               # detalleError() — console.error se come e.message
│       ├── sanitize.ts              # Limpieza de contenido antes de publicar
│       └── verifyWebhookSignature.ts # Verificación HMAC del webhook
├── test/
│   └── identidad.test.ts            # node --test, con el borrado de tipos de Node
├── wrangler.toml                    # Configuración de Cloudflare Workers
├── package.json
├── tsconfig.json
└── README.md
```



## Requisitos previos

- Node.js v18+
- Cuenta de Cloudflare (capa gratuita)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/): `npm install -g wrangler`
- GitHub App creada (ver sección abajo)
- Repo privado de soporte dedicado (ej. `livestock-manager-support-tickets`)

## Configuración inicial

### 1. Clonar e instalar

```bash
git clone https://github.com/SADOCKDOG/livestock-manager-support-api.git
cd livestock-manager-support-api
npm install
```

### 2. Crear la GitHub App

1. `Settings → Developer settings → GitHub Apps → New GitHub App`
2. Permisos: **Issues → Read & Write** (nada más)
3. Suscribirse a eventos: `Issues`, `Issue comment`
4. Generar y descargar la clave privada
5. Instalar la App únicamente en el repo de soporte dedicado
6. Anotar: `App ID`, `Installation ID`, contenido de la clave privada

### 3. Configurar secretos en Cloudflare

```bash
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put GITHUB_APP_INSTALLATION_ID
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put AI_API_KEY
wrangler secret put GOOGLE_PLAY_SERVICE_ACCOUNT_JSON
wrangler secret put JWT_SECRET
```

Y, para la compra en Microsoft Store (app de escritorio), los tres de la
aplicación registrada en Entra ID:

```bash
wrangler secret put MS_ENTRA_TENANT_ID
wrangler secret put MS_ENTRA_CLIENT_ID
wrangler secret put MS_ENTRA_CLIENT_SECRET
```

Van como **secretos**, nunca como `[vars]` de `wrangler.toml`: una var vacía
pisa al secreto del mismo nombre y deja el servicio sin verificar compras. Si
falta cualquiera de los tres, las rutas de Windows responden `501
MS_STORE_NO_CONFIGURADO` en vez de fallar a ciegas.

### 4. Configurar `wrangler.toml`

```toml
name = "livestock-manager-support-api"
main = "src/index.ts"
compatibility_date = "2026-01-01"

[[kv_namespaces]]
binding = "TICKETS_KV"
id = "<generar con: wrangler kv:namespace create TICKETS_KV>"
```

### 5. Desarrollo local

```bash
npm run dev
```

### 6. Comprobaciones antes de desplegar

```bash
npm run typecheck
npm test
```

Las pruebas usan `node --test` con el borrado de tipos nativo de Node (>= 22):
no hacen falta dependencias ni compilación previa.

### 7. Despliegue

```bash
npm run deploy
```

### 8. Configurar el webhook en GitHub

En el repo de soporte dedicado: `Settings → Webhooks → Add webhook`
- URL: `https://<tu-worker>.workers.dev/webhooks/github`
- Secret: el mismo valor que `GITHUB_WEBHOOK_SECRET`
- Eventos: `Issues`, `Issue comments`

## Endpoints

| Método | Ruta | Auth requerida | Para qué |
|---|---|---|---|
| `POST` | `/tickets` | JWT + licencia activa | Estructura el reporte con IA y devuelve un borrador |
| `POST` | `/tickets/confirm` | JWT + licencia activa | Crea el issue en GitHub y lanza el agente |
| `GET` | `/tickets` | JWT | Listado propio, con estado y número de respuestas |
| `GET` | `/tickets/:id` | JWT | Detalle con el hilo completo |
| `POST` | `/tickets/:id/responder` | JWT | Mensaje del usuario en una incidencia abierta |
| `POST` | `/tickets/:id/confirmar` | JWT | El usuario acepta la resolución y se cierra el issue |
| `POST` | `/auth/verify-purchase` | No | Verifica la compra y devuelve el JWT de sesión. El campo `plataforma` decide contra quién: `android` → Google Play, `windows` → Microsoft Store |
| `POST` | `/auth/ms/ticket` | No | Acuña el ticket de Entra ID que WinRT necesita para pedir la Store ID key. Abierta por necesidad (aún no hay sesión), limitada por IP: `429 LIMITE_TICKETS_MS` al superar `MAX_TICKETS_MS_POR_HORA` (30/hora por defecto) |
| `GET` | `/auth/me` | JWT | Estado de la sesión y de la licencia |
| `POST` | `/webhooks/github` | Firma HMAC | Etiquetas, comentarios y cierre del issue |

Las rutas de lectura y de mensaje **no exigen licencia activa**, a propósito: quien
ya abrió una incidencia puede seguir hablando de ella aunque su licencia caduque.

## Identidad del usuario

No hay cuentas ni contraseñas. En **Android** el `user_id` son los 16 primeros
bytes del `SHA-256("usuario:" + purchase_token)`, así que un borrado de datos o
un móvil nuevo no pierden el historial: Google Play restaura el token y sale el
mismo id.

En **Windows** no existe un token de compra equivalente: lo que viaja en
`purchase_token` es la *Store ID key*, que caduca a los 30 días y por tanto no
puede anclar una identidad. El id se deriva del `order_id` que devuelve la
Collection API de Microsoft —`hashUserIdWindows(licencia.order_id)`—, que sí es
estable para la misma compra. El mecanismo de id de instalación descrito abajo
funciona igual en las dos plataformas.

El `purchase_token` sí cambia en una **recompra** (la suscripción caduca y se
vuelve a contratar, o se cambia de plan). Para no dejar huérfano el historial,
la app manda además un **id de instalación** — generado en el dispositivo,
guardado en el almacén `meta` de su IndexedDB, y por tanto incluido en la copia
de seguridad. El Worker lo indexa como `instalacion:<id> → user_id`.

Cuando llega un token desconocido con un id de instalación ya visto, el Worker
**no adopta la identidad anterior sin comprobarla**. Por orden:

1. Si Google encadena la compra nueva con la anterior (`linkedPurchaseToken`),
   es el mismo comprador y se adopta. Es la única prueba server-side de que dos
   tokens distintos son la misma persona, y cubre el caso normal: recomprar
   antes de que caduque la anterior, con las dos licencias vivas a la vez.
2. Si no hay encadenamiento, se consulta a Google el token viejo. Caducado, se
   adopta. Todavía activo, se rechaza: son dos personas — alguien ha restaurado
   una copia ajena — y antes que enseñar un historial ajeno, historial vacío.
3. Si la consulta falla, se rechaza también: un historial enseñado a quien no es
   no se deshace.

**Rechazar la adopción no puede tocar `instalacion:<id>`.** El enlace es el
único camino de vuelta al historial: si se reescribe apuntando al usuario nuevo
y vacío, la pérdida es permanente y ni restaurar la copia de seguridad la
arregla, porque el id restaurado vuelve a llevar al mismo usuario vacío. Pasó en
producción el 2026-09-03. Por eso la decisión vive aislada del KV en
`src/services/identidad.ts`, con pruebas (`npm test`), y devuelve por separado
la identidad y el permiso para escribir el enlace. Por la misma razón, un
usuario ya conocido tampoco se queda con el enlace si apunta a otro.

El `email` es opcional y solo sirve de último recurso manual. Se indexa como
`email:<correo> → user_id` **solo si existe**; sin ese guardia todos los
usuarios sin correo compartían la clave `email:` y el último se la llevaba.

| Clave en KV | Contenido |
|---|---|
| `usuario:<user_id>` | Ficha completa: correo, plataforma, token, licencia |
| `instalacion:<id>` | `user_id` al que quedó vinculada esa instalación |
| `email:<correo>` | `user_id`, solo para usuarios que hayan dado correo |

## Seguridad

- Ningún token de GitHub llega nunca al cliente.
- Rate limiting por usuario (por defecto: 5 tickets/día, configurable).
- Todo el contenido generado por IA se sanitiza antes de publicarse como issue.
- Las propuestas de fix de la IA nunca se aplican automáticamente — quedan como comentario/draft PR pendiente de revisión manual.
- Verificación de compra siempre server-side: Google Play Developer API en
  Android, Microsoft Store Collection API en Windows. El cliente nunca decide si
  su licencia es válida.

## Cómo funciona una incidencia

### Estados

| Estado | Quién lo pone | Qué significa para el usuario |
|---|---|---|
| `enviada` | El Worker, al crear el issue | Registrada, nadie la ha mirado |
| `analizada` | El agente de IA | El asistente la ha analizado y ha respondido |
| `revision` | Un mantenedor (etiqueta o comentario) | Una persona la está mirando |
| `curso` | Un mantenedor | Confirmada como fallo, se trabaja en ella |
| `resuelta` | Un mantenedor | El equipo la da por resuelta — **propuesta, no cierre** |

Los estados tienen rango (`RANGO_ESTADO` en `src/types.ts`). Los eventos de
GitHub no llegan ordenados, así que el estado automático `analizada` nunca
puede hacer retroceder una incidencia que un mantenedor ya movió. Lo que decide
una persona manda siempre, incluso hacia atrás.

### El agente

Se ejecuta una sola vez, en `POST /tickets/confirm`, y hace tres cosas: publica
una hipótesis técnica para el equipo, publica una respuesta para el usuario y
mueve la incidencia a `analizada`. Las incidencias creadas antes de existir el
agente se quedan en `enviada` para siempre; es lo esperado.

### Marcadores

La GitHub App publica con una sola identidad, así que los tres tipos de
comentario se distinguen por un marcador HTML en la primera línea
(`src/utils/agente.ts`):

| Marcador | Qué es | Llega a la app |
|---|---|---|
| *(ninguno)* | Hipótesis técnica de la IA | No |
| `<!-- livestock:respuesta-agente -->` | Respuesta del agente al usuario | Sí, como «Asistente automático» |
| `<!-- livestock:mensaje-usuario -->` | Mensaje escrito desde la app | No — ya está en KV |

Son infalsificables porque `limpiarTexto()` borra los comentarios HTML de todo
lo que escriben el usuario y la IA.

### Confirmación de la resolución

`resuelta` la marca el equipo, que no puede saber si al usuario le ha servido.
Hasta que llega su confirmación es una propuesta, y la app se lo pregunta:

- **Sí** → `POST /tickets/:id/confirmar`: fija `confirmada_at`, comenta y cierra
  el issue. Es el cierre real.
- **No** → un mensaje normal por `/responder`: reabre el issue y devuelve la
  incidencia a `revision` (no a `curso`: vuelve a la cola, nadie está con ella).

El «no» no es un botón aparte, es el de enviar el mensaje: rechazar una
solución obliga a contar qué sigue fallando.

Las dos degradaciones ante un fallo de GitHub van a propósito en sentidos
opuestos. Al **reabrir**, si GitHub no acepta, no se toca el estado local: una
incidencia «en revisión» con el issue cerrado no la ve nadie. Al **confirmar**,
si GitHub falla se guarda igual: para el usuario el asunto está zanjado, y un
issue abierto de más solo cuesta una revisión.

### Límites

Dos cupos diarios **separados**, por usuario y en UTC: `MAX_TICKETS_PER_DAY`
(5) y `MAX_MENSAJES_PER_DAY` (10). Agotar el de mensajes respondiendo a soporte
no debe impedirte reportar un fallo nuevo.

## Notas de operación

- **KV es eventualmente consistente en lectura**: `wrangler kv key get` puede
  devolver un valor viejo hasta ~60 s después de que el Worker haya escrito. Para
  comprobar si un webhook se aplicó, mira la respuesta de la entrega en GitHub,
  no KV.
- **Wrangler no hereda bindings ni vars por entorno**: todo lo que esté en
  `[vars]` hay que repetirlo en `[env.production.vars]`.
- Un `var` vacío **pisa** al secreto del mismo nombre.
- Las etiquetas `estado:*` las crea GitHub sola al asignarlas, pero conviene
  tenerlas creadas en el repo de soporte para que salgan con color en el tablero.

## Estado del proyecto

✅ **En producción.** Ciclo completo verificado de punta a punta: creación,
respuesta del agente, mensajes en las dos direcciones, los cinco estados y el
cierre con `cerrada_at`.

Pendiente: notificaciones push al usuario cuando llega una respuesta (hoy la app
solo consulta al abrirse y al volver del segundo plano) y aviso al equipo cuando
el usuario escribe (se resuelve con los ajustes de watch del repo de soporte, sin
código).

## Licencia

Uso exclusivo interno — Livestock Manager.



---

## 💚 Support the project

If this project helps you save time, reduce errors, or improve operations, consider sponsoring it.

[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub-ff69b4?style=for-the-badge&logo=github)](https://github.com/sponsors/SADOCKDOG)

Your support helps me:
- keep the project running
- improve features and stability
- expand documentation and support
- develop new tools and integrations

Thank you for supporting the project.
