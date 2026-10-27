# Cómo contribuir — livestock-manager-support-api

Este proyecto es un backend de soporte opcional para Livestock Manager. No forma parte del repo principal y tiene release cycle independiente.

## A quién va dirigido

- Mantenedores del proyecto Livestock Manager que necesiten integrar el servicio de IA.
- Desarrolladores que quieran añadir endpoints, mejorar el agente de IA o ajustar el rate limiting.
- No está orientado a usuarios finales: el consumo es vía Worker Cloudflare, no desde el frontend directamente.

## Pasos para añadir un endpoint nuevo

1. **Decidir el tipo de ruta**:
   - ¿Requiere licencia activa? (`requiereLicencia` middleware)
   - ¿Requiere sesión JWT? (`requiereSesion` middleware)
   - ¿Afecta rate limiting? (`limitarTickets` / `limitarMensajes` middleware)
   - ¿Es privado (solo admin) o público (cualquier usuario con JWT)?

2. **Añadir la ruta en `src/routes/`**:
   - Archivo propio si es complejo, o añadir en `auth.ts` / `tickets.ts`.
   - Exportar el router por defecto.

3. **Añadir el middleware si hace falta**:
   - En `src/middleware/` si es reutilizable (rate limit, validación, etc.).
   - Importar y encadenar en el router Hono.

4. **Tipado** (obligatorio):
   - Todo debe estar tipado con `typescript` — no se aceptan `any` sueltos.
   - Revisar `src/types.ts` para nuevos tipos, o añadirlos ahí.
   - Los parámetros de ruta/body deben tener tipos explícitos.

5. **Rate limiting** (siempre que sea creación/escritura):
   - `limitarTickets` (por usuario/día) — tickets nuevos.
   - `limitarMensajes` (por usuario/día) — mensajes en incidencia abierta.
   - `MAX_TICKETS_PER_DAY` (default 5) y `MAX_MENSAJES_PER_DAY` (default 10) en `wrangler.toml [vars]`.
   - Para Microsoft Store: `MAX_TICKETS_MS_POR_HORA` (default 30) en `wrangler.toml [env.production.vars]`.

6. **Rate limiting para Microsoft Store** (escenarios anonimos por IP):
   - En `msStoreBilling.ts` ya hay `contarAcunadosDeLaHora` / `incrementarAcunadosDeLaHora` con TTL de 3h.
   - Si añades una ruta que acuna tickets MS, añade límite similar.

7. **IA (si aplica)**:
   - Los endpoints que usen IA deben llamar a `c.env.AI`.
   - El agente se ejecuta en `c.executionCtx.waitUntil` para no bloquear la respuesta HTTP.
   - Toda salida de IA pasa por `sanitize.ts` antes de publicarse (evita HTML no seguro).
   - La hipótesis técnica de la IA nunca se lee como parte del reporte del usuario (se filtra en el webhook por falta de marcador).

8. **GitHub App** (si modifica issue management):
   - Los permisos son solo `Issues: Read & Write` — nada de commits, ramas ni PRs.
   - La GitHub App publica con identidad única, así que los comentarios se distinguen por marcadores HTML (`<!-- livestock:respuesta-agente -->`, `<!-- livestock:mensaje-usuario -->`).
   - Usar `limpiarTexto()` para borrar marcadores HTML del contenido que escriben usuario y IA.

9. **Probar local** (`wrangler dev`):
   - Configurar `.dev.vars` con los secretos correspondientes.
   - Las rutas de Windows (`/auth/ms/ticket`, `/auth/ms/ticket-compras`) requieren `MS_ENTRA_TENANT_ID`, `MS_ENTRA_CLIENT_ID`, `MS_ENTRA_CLIENT_SECRET`.
   - Para Android testing local: `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
   - Nunca actives `ENTORNO=development` en entornos desplegados — salta la verificación de licencia.

10. **Desplegar** (`npm run deploy`):
    - Verificar que todos los secretos están en Cloudflare (no en `wrangler.toml [vars]`).
    - Revisar `npm run typecheck` y `npm test` antes.
    - Confirmar que no hay bindings vacíos (`[vars]` pisan los secretos del mismo nombre).

## Estilo de código

- **Nombres descriptivos**: funciones, variables y tipos deben tener nombres significativos (evitar `x`, `data`, `resp` genéricos).
- **Sin efecto secundario en handlers**: los handlers HTTP deben ser puros o limitarse a llamar a servicios. No escribir en KV directamente salvo que sea necesario.
- **Manejo de errores**: devolver JSON con `{ error: 'mensaje', codigo: 'CÓDIGO' }` y status HTTP apropiado (400, 403, 404, 429, 500, 502).
- **Logs**: usar `console.info` o `console.warn` para eventos relevantes; `console.error` + `detalleError(e)` para fallos.
- **Marcadores HTML**: si publicas contenido generado por IA en issues, incluye el marcador `<!-- livestock:respuesta-agente -->` para que la app lo distinga.

## Commit y PR

- Los commits deben tener mensaje descriptivo y terminar con `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- Las PRs deben tener título y cuerpo claros, describiendo qué cambio trae y por qué es necesario.
- Si la PR toca IA, debe incluirse una breve descripción de los casos de prueba (o motivo por el cual no hay tests automatizados).
- Se revisa tipo (`npm run typecheck`) antes de aprobar.

## Preguntas frecuentes

### ¿Puedo añadir login / auth real?

No. El principio de este backend es **nunca exponer credenciales al cliente**. La identidad se ancla a la compra (Google Play token o Microsoft Store orderId), no a cuentas ni contraseñas. Cuando se decida (Google Sign-In o email+OTP), se añade el endpoint correspondiente y se conserva `emitirSesion`, pero hoy la identidad va anclada a la compra.

### ¿Puedo cambiar el modelo de rate limiting?

Sí, pero hay que actualizar:
1. `wrangler.toml [vars]` para `MAX_TICKETS_PER_DAY` / `MAX_MENSAJES_PER_DAY`.
2. `wrangler.toml [env.production.vars]` para `MAX_TICKETS_MS_POR_HORA`.
3. Los contadores en `src/middleware/rateLimit.ts`.
4. Los límites en `src/routes/auth.ts` (`/auth/ms/ticket-compras`).

### ¿Puedo añadir soporte para otra plataforma (Linux, web)?

El proyecto está enfocado en Android (Google Play) + Windows (Microsoft Store). Añadir plataformas requiere:
- Nueva lógica de verificación de compra.
- Nuevos endpoints `/auth/verify-purchase` con el provider correspondiente.
- Actualizar `src/types.ts` con nuevos valores de `Plataforma`.
- Revisar que no haya colisiones con los existentes.

## Licencia

Todos los derechos reservados. La aplicación Livestock Manager puede usarse gratuitamente según las condiciones de la Microsoft Store; el código de este backend no se distribuye bajo licencia de código abierto.