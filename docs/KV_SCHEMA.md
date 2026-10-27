# Esquema KV — livestock-manager-support-api

Esquema completo del almacenamiento en Cloudflare KV (`TICKETS_KV`) del Worker de soporte. Todos los valores se serializan como JSON salvo que se indique lo contrario como texto.

> **Nota:** KV es de consistencia eventual. Sirve para el mapeo, pero como contador de rate limiting puede burlarse con peticiones en paralelo. Si eso llega a importar, el contador debería moverse a Durable Objects o D1.

## Claves de usuario

| Clave | Valor | TTL | Descripción |
|---|---|---|---|
| `usuario:<user_id>` | `Usuario` (JSON) | — | Ficha completa: correo, plataforma, token de compra, licencia |
| `email:<email>` | `user_id` (texto) | — | Índice inverso para login por correo. Solo si el usuario tiene correo |
| `instalacion:<id>` | `user_id` (texto) | — | Puentes la compra nueva con la misma instalación (IndexedDB, viaja en copia de seguridad) |

### Tipo `Usuario`

```typescript
interface Usuario {
  user_id: string;
  email: string;
  plataforma: 'android' | 'web' | 'windows';
  purchase_token?: string;      // Android: purchase_token de Google Play; Windows: orderId de MS Store
  instalacion_id?: string | null;
  licencia_soporte_activa: boolean;
  licencia_expira: string | null; // ISO 8601; null = compra única sin caducidad
}
```

## Claves de ticket

| Clave | Valor | TTL | Descripción |
|---|---|---|---|
| `ticket:<ticket_id>` | `Ticket` (JSON) | — | Ticket completo, incluye respuestas del equipo |
| `issue:<numero>` | `ticket_id` (texto) | — | Mapeo número de issue GitHub → ticket (para el webhook) |
| `tickets-usuario:<user_id>` | `string[]` (JSON) | — | Lista de ticket_id del usuario, más reciente primero (máx. 200) |
| `borrador:<ticket_id>` | `BorradorTicket + user_id` (JSON) | 1800 s (30 min) | Borrador pre-confirmación del usuario |
| `reabiertas:<ticket_id>` | `number` (texto) | — | Cuántas veces el usuario ha reabierto desde `resuelta` |

### Tipo `Ticket`

```typescript
interface Ticket {
  ticket_id: string;
  github_issue_number: number | null;
  user_id: string;
  estado: 'enviada' | 'analizada' | 'revision' | 'curso' | 'resuelta';
  titulo: string;
  severidad: 'alta' | 'media' | 'baja';
  created_at: string;   // ISO 8601
  updated_at: string;   // ISO 8601
  respuestas?: RespuestaTicket[];  // más antigua → más reciente (máx. 50)
  cerrada_at?: string | null;      // primera vez que pasa a resuelta
  confirmada_at?: string | null;   // cuando el usuario confirma que funciona
}

interface RespuestaTicket {
  fecha: string;    // ISO 8601
  texto: string;
  cierre?: boolean;
  autor?: 'ia' | 'equipo' | 'usuario';
}
```

### Tipo `BorradorTicket`

```typescript
interface BorradorTicket {
  ticket_id: string;
  titulo: string;
  descripcion: string;
  pasos_reproduccion: string[];
  severidad: 'alta' | 'media' | 'baja';
  posible_causa?: string;   // hipótesis técnica de la IA, nunca código
}
```

## Claves de rate limiting

| Clave | Valor | TTL | Descripción |
|---|---|---|---|
| `ratelimit:<user_id>:<dia>` | contador (texto) | 172800 s (48 h) | Tickets creados hoy por usuario (UTC) |
| `ratelimit:msticket:<ip>:<hora>` | contador (texto) | 10800 s (3 h) | Acunados de clave Microsoft Store por IP y hora (anónimo) |
| `msgs:<user_id>:<dia>` | contador (texto) | 172800 s (48 h) | Mensajes del usuario en tickets abiertos hoy (UTC) |

### Cupos (valores por defecto en código)

- `MAX_TICKETS_PER_DAY` = 5 tickets por usuario y día
- `MAX_MENSAJES_PER_DAY` = 10 mensajes por usuario y día
- `MAX_TICKETS_MS_POR_HORA` = 30 acunados por IP y hora (ruta `/auth/ms/ticket-compras`)

## Reglas críticas

1. **El borrador solo tiene que sobrevivir a la confirmación del usuario.** TTL de 30 minutos. Si caduca, el usuario debe volver a describir la incidencia.
2. **El índice `email:` solo se escribe si existe el correo.** Sin este guardia, todos los usuarios sin correo compartían la clave y el último se la llevaba.
3. **Al cambiar el correo de un usuario, se retira el índice anterior** (`retirarIndiceEmail`). Solo si el índice apunta todavía a ese `user_id`.
4. **El contador de reabiertas vive en clave aparte**, no dentro del ticket. El webhook guarda una copia a veces vieja del ticket; si el contador estuviera dentro, lo devolvería atrás.
5. **KV no tiene escrituras condicionales y sus lecturas van con retraso.** `aplicarEventoDeIssue` lee, modifica y guarda sobre una foto que puede ser vieja; si guarda igual, machaca lo escrito entre medias.
6. **`tickets-usuario:<user_id>` se corta a 200 entradas.** Los tickets más antiguos dejan de listarse.
7. **Las respuestas de un ticket se cortan a 50.** Un hilo eterno no aporta nada al usuario y engorda cada lectura del listado.

## Ejemplos de contenido

```json
// usuario:<user_id>
{
  "user_id": "a1b2c3d4",
  "email": "ganadero@ejemplo.com",
  "plataforma": "android",
  "purchase_token": "abc123...",
  "instalacion_id": "inst-xyz789",
  "licencia_soporte_activa": true,
  "licencia_expira": "2026-11-01T00:00:00.000Z"
}
```

```json
// ticket:<ticket_id>
{
  "ticket_id": "tic-550e8400-e29b-41d4-a716-446655440000",
  "github_issue_number": 42,
  "user_id": "a1b2c3d4",
  "estado": "analizada",
  "titulo": "La pantalla de pesajes no guarda",
  "severidad": "alta",
  "created_at": "2026-10-15T09:30:00.000Z",
  "updated_at": "2026-10-15T10:15:00.000Z",
  "respuestas": [
    { "fecha": "2026-10-15T09:45:00.000Z", "texto": "...", "autor": "ia" },
    { "fecha": "2026-10-15T10:15:00.000Z", "texto": "...", "autor": "equipo" }
  ],
  "cerrada_at": null,
  "confirmada_at": null
}
```

```text
// email:<correo>   (texto plano)
a1b2c3d4

// instalacion:<id>   (texto plano)
a1b2c3d4

// tickets-usuario:<user_id>   (JSON)
["tic-550e8400...", "tic-11111111..."]

// borrador:<ticket_id>   (JSON)
{ "ticket_id": "...", "titulo": "...", "descripcion": "...", "pasos_reproduccion": [], "severidad": "media" }
```

## Cómo se usa desde el código

Toda la lectura/escritura está encapsulada en `src/services/storage.ts` (clase `Almacen`). No se accede al KV directamente desde las rutas. Los métodos públicos son:

- `obtenerUsuario / guardarUsuario / obtenerUsuarioPorEmail / retirarIndiceEmail`
- `obtenerUsuarioPorInstalacion / vincularInstalacion`
- `guardarBorrador / obtenerBorrador / borrarBorrador`
- `guardarTicket / obtenerTicket / listarTicketsDeUsuario / aplicarEventoDeIssue / anadirRespuesta`
- `contarReabiertas / incrementarReabiertas`
- `contarTicketsDelDia / incrementarContadorDelDia`
- `contarAcunadosDeLaHora / incrementarAcunadosDeLaHora`
- `contarMensajesDelDia / incrementarMensajesDelDia`
