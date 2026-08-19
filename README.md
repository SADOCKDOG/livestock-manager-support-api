# livestock-manager-support-api

Backend de soporte con IA para Livestock Manager. Recibe incidencias desde la app, las estructura con IA, y crea issues en un repositorio de soporte dedicado vía GitHub App — sin exponer nunca credenciales al cliente.

Repo independiente de `LIVESTOCK-MANAGER` y `livestock-pwa-msix`: no comparte historial git ni build. Ver `docs/SOPORTE_IA.md` en el repo principal para el diseño completo.

## Stack

- **Runtime**: Cloudflare Workers
- **Almacenamiento**: Cloudflare KV (mapeo tickets) — migrar a D1 si se necesita consulta relacional más adelante
- **IA**: API del proveedor elegido (pendiente de definir)
- **GitHub**: GitHub App (permisos `Issues: Read & Write` únicamente)
- **Verificación de compra**: Google Play Developer API

## Estructura del proyecto

livestock-manager-support-api/
├── src/
│ ├── index.ts # Entry point, router de rutas
│ ├── routes/
│ │ ├── tickets.ts # POST /tickets, POST /tickets/confirm, GET /tickets, GET /tickets/:id
│ │ ├── auth.ts # POST /auth/verify-purchase
│ │ └── webhooks.ts # POST /webhooks/github
│ ├── services/
│ │ ├── ai.ts # Estructuración de reportes con IA
│ │ ├── github.ts # Auth de GitHub App + creación de issues
│ │ ├── playBilling.ts # Verificación de compra Google Play
│ │ └── storage.ts # Lectura/escritura en KV
│ ├── middleware/
│ │ ├── auth.ts # Validación de JWT de sesión
│ │ └── rateLimit.ts # Límite de tickets por usuario/día
│ └── utils/
│ ├── sanitize.ts # Limpieza de contenido antes de publicar en GitHub
│ └── verifyWebhookSignature.ts # Verificación HMAC del webhook
├── wrangler.toml # Configuración de Cloudflare Workers
├── package.json
├── tsconfig.json
└── README.md

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

### 6. Despliegue

```bash
npm run deploy
```

### 7. Configurar el webhook en GitHub

En el repo de soporte dedicado: `Settings → Webhooks → Add webhook`
- URL: `https://<tu-worker>.workers.dev/webhooks/github`
- Secret: el mismo valor que `GITHUB_WEBHOOK_SECRET`
- Eventos: `Issues`, `Issue comments`

## Endpoints

| Método | Ruta | Auth requerida |
|---|---|---|
| `POST` | `/tickets` | JWT + licencia activa |
| `POST` | `/tickets/confirm` | JWT + licencia activa |
| `GET` | `/tickets` | JWT |
| `GET` | `/tickets/:id` | JWT |
| `POST` | `/auth/verify-purchase` | JWT |
| `POST` | `/webhooks/github` | Firma HMAC |

## Seguridad

- Ningún token de GitHub llega nunca al cliente.
- Rate limiting por usuario (por defecto: 5 tickets/día, configurable).
- Todo el contenido generado por IA se sanitiza antes de publicarse como issue.
- Las propuestas de fix de la IA nunca se aplican automáticamente — quedan como comentario/draft PR pendiente de revisión manual.
- Verificación de compra siempre server-side contra Google Play Developer API.

## Estado del proyecto

🚧 En diseño — ver fases de implementación en `docs/SOPORTE_IA.md` del repo principal.

## Licencia

Uso exclusivo interno — Livestock Manager.

