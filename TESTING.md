# Guía de testing — livestock-manager-support-api

## Framework de pruebas

- **Node.js nativo**: usa `node --test` (Node >= 22).
- Sin dependencias externas de testing (no Jest, Vitest, etc.).
- Borrado de tipos nativo (`--experimental-strip-types` ya no necesario en Node 22+).
- Ubicación: `test/` (ej. `test/identidad.test.ts`).

## Qué se testea

| Archivo | Qué cubre | Ejecutar |
|---|---|---|
| `test/identidad.test.ts` | `resolverIdentidad()` — 13 escenarios de adopción/renuncia de identidad | `npm test` |
| Tests futuros | Endpoints, rate limiting, sanitización, IA | pendiente |

## Cómo ejecutar

```bash
# Todos los tests
npm test

# Test específico
node --test test/identidad.test.ts

# Con cobertura (opcional, requiere @node/coverage)
node --test --experimental-test-coverage test/identidad.test.ts
```

## Estructura de un test

```typescript
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

describe('resolverIdentidad', () => {
  test('adopta identidad conocida si instalación libre', async () => {
    const resultado = await resolverIdentidad({
      lectura: mockAlmacen,
      userIdDelToken: 'nuevo-hash',
      purchaseToken: 'token-nuevo',
      instalacion: 'inst-123',
      comprobarLicencia: async () => ({ activa: false }),
    });
    assert.equal(resultado.userId, 'nuevo-hash');
    assert.equal(resultado.vincularInstalacion, true);
  });
});
```

## Mocks y fixtures

- **Almacen mock**: implementa `LecturaIdentidad` (`obtenerUsuario`, `obtenerUsuarioPorInstalacion`).
- Usar `async`/`await` — los tests son async por naturaleza.
- No hay `beforeEach`/`afterEach` global: cada test configura su propio mock.

## Testing local con `wrangler dev`

### Preparación

```bash
# 1. Copiar template
cp .dev.vars.example .dev.vars

# 2. Rellenar secretos obligatorios
#    - JWT_SECRET (cualquier string largo)
#    - GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (solo para Android testing local)
#    - MS_ENTRA_TENANT_ID / MS_ENTRA_CLIENT_ID / MS_ENTRA_CLIENT_SECRET (para Windows local)

# 3. Sembrar KV con usuario de prueba (ver docs/KV_SCHEMA.md)
#    wrangler kv key put --binding=TICKETS_KV "usuario:<user_id>" '{"user_id":"...","email":"...",...}'
```

### Endpoints no testables en local

| Endpoint | Por qué no testable | Qué hacer |
|---|---|---|
| `/auth/verify-purchase` (android) | Llama a Google Play Developer API real | Usar `ENTORNO=development` para saltar verificación |
| `/auth/verify-purchase` (windows) | Llama a Microsoft Store Collection API real | Usar `ENTORNO=development` + usuario sembrado en KV |
| `/auth/ms/ticket-compras` | Requiere Entra ID configurado + ticket WinRT | Probar solo con Worker desplegado |
| `/webhooks/github` | Requiere HMAC válido de GitHub App | Simular con `curl` + firma HMAC local |

### Testing del flujo de identidad completo

La única forma realista de probar el flujo completo (incluyendo Store ID key y verificación de licencia Microsoft) es:

1. **Desplegar Worker en entorno de staging** (`wrangler deploy --env staging`).
2. **Instalar MSIX firmado** desde Partner Center (vuelo) en Windows real.
3. **Iniciar sesión en Microsoft Store** con la cuenta que compró `support_unlock`.
4. **Lanzar la app** y verificar que valida la licencia.

En `wrangler dev` **no funciona** porque:
- `tauri dev` no tiene identidad de paquete → WinRT no emite Store ID key.
- La compra real requiere la app instalada desde la Store (Partner Center).

### Testing con usuario sembrado en KV (local)

Para probar rutas que **requieren sesión** (`/tickets`, `/tickets/confirm`, `/auth/me`, etc.) sin Store ID key:

```bash
# 1. Calcular user_id (hash SHA-256 de "usuario:" + purchase_token)
node -e "crypto.subtle.digest('SHA-256', new TextEncoder().encode('usuario:test-token')).then(b=>console.log(Array.from(new Uint8Array(b)).slice(0,16).map(x=>x.toString(16).padStart(2,'0')).join('')))"

# 2. Sembrar usuario en KV
wrangler kv key put --binding=TICKETS_KV "usuario:<hash>" '{"user_id":"<hash>","email":"test@ejemplo.com","plataforma":"android","purchase_token":"test-token","instalacion_id":"inst-test","licencia_soporte_activa":true,"licencia_expira":"2099-12-31T00:00:00.000Z"}'

# 3. Generar JWT local
node -e "
const { SignJWT } = await import('jose');
const token = await new SignJWT({email:'test@ejemplo.com',plataforma:'android'})
  .setProtectedHeader({alg:'HS256'})
  .setSubject('<hash>')
  .setIssuedAt()
  .setExpirationTime('24h')
  .sign(new TextEncoder().encode('test-secret'));
console.log(token);
"

# 4. Probar con curl
curl -H "Authorization: Bearer <JWT>" http://localhost:8787/tickets
```

### CORS y puerto 8088

- `wrangler dev` por defecto en `http://localhost:8787`.
- Si la app frontend llama a `localhost:8787`, necesita CORS permitido (el Worker ya lo permite por defecto).
- Puerto 8088 usado en validación manual anterior (`http-server -p 8088`) — no testear contra ese puerto a menos que sepas qué repo sirve ahí (ver [[servidor-validacion-proyecto-equivocado]]).

## Debugging

- Logs en `wrangler dev`: `console.info` / `console.warn` / `console.error` salen en terminal.
- En producción: `wrangler tail` para ver logs en vivo.
- `detalleError(e)` en `src/utils/errores.ts` extrae mensaje legible de cualquier error.

## Casos de prueba recomendados (por implementar)

- [ ] `POST /tickets` — borrador creado y guardado en KV.
- [ ] `POST /tickets/confirm` — issue creado en GitHub, agente responde.
- [ ] `GET /tickets` — listado con estados y contadores correctos.
- [ ] `POST /tickets/:id/responder` — mensaje publicado en GitHub + KV.
- [ ] `POST /tickets/:id/confirmar` — issue cerrado, `confirmada_at` fijado.
- [ ] Rate limiting: 6º ticket en un día → 429.
- [ ] Rate limiting MS: 31 acunados en una hora → 429.
- [ ] Sanitización: HTML inyectado en descripción → limpiado.
- [ ] Webhook GitHub: etiqueta `estado:curso` aplicada → ticket actualizado a `curso`.
- [ ] Webhook GitHub: comentario sin marcador → no llega a app.
- [ ] Identidad: recompra encadenada → adopción correcta.
- [ ] Identidad: dos licencias vivas → rechazo + historial vacío.
- [ ] Identidad: sin instalación → adopción sin enlace.

## CI / Pre-commit

```bash
# Antes de commit / PR
npm run typecheck  # tsc --noEmit
npm test           # node --test
npm run lint       # si se añade eslint en el futuro
```