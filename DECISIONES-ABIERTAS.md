# Decisiones abiertas — livestock-manager-support-api

Este documento registra las decisiones pendientes que afectan al backend de soporte. Cada una incluye el contexto, por qué sigue abierta y qué se necesita para cerrarla.

## 1. Pago web para la PWA (Stripe u otro proveedor)

**Estado:** Pendiente — decisión de negocio requerida.

**Contexto:** La ruta `POST /auth/verify-purchase` con `plataforma: web` responde `501 PAGO_WEB_NO_CONFIGURADO` porque no hay un proveedor de pagos configurado para la PWA (ver `src/routes/auth.ts` línea 151-161). El `STRIPE_SECRET_KEY` está definido como opcional en `src/types.ts` pero nunca se usa en código.

**¿Qué se necesita para cerrar?**
- Elegir proveedor (Stripe recomendado por simplicidad de integración con PWA).
- Añadir `STRIPE_SECRET_KEY` como secreto en Cloudflare (nunca en `wrangler.toml [vars]`).
- Implementar la ruta de verificación de compra web en `src/routes/auth.ts`.
- Actualizar `.dev.vars.example` con `STRIPE_SECRET_KEY`.
- Documentar el flujo de compra web en el README.

**Bloqueador:** Ninguno técnico. Es una decisión de negocio sobre modelo de cobro (suscripción mensual opcional, como `support_unlock`).

## 2. URL del Worker de soporte para la app móvil y PWA

**Estado:** Pendiente — requiere despliegue del Worker.

**Contexto:** En `LIVESTOCK-MANAGER/js/services/support-api.js` (línea ~13) la `BASE` es el placeholder `https://livestock-manager-support-api.workers.dev` marcado `PENDIENTE`. El módulo de soporte está cableado pero "sin activar" hasta que se conozca la URL real del Worker desplegado.

**¿Qué se necesita para cerrar?**
- Desplegar el Worker: `npx wrangler deploy` desde `livestock-manager-support-api/`.
- Confirmar la URL pública resultante (ej. `https://livestock-manager-support-api.<subdomain>.workers.dev`).
- Actualizar `BASE` en `LIVESTOCK-MANAGER/js/services/support-api.js` (y en PWA si procede).
- Activar el módulo de soporte en la app.

**Bloqueador:** Coste por uso de Workers AI. Decisión de negocio requerida antes de desplegar en producción.

## 3. Proveedor de IA (actual: Workers AI Nemotron)

**Estado:** Decidido, con alternativas abiertas.

**Contexto:** El Worker usa Cloudflare Workers AI con el modelo `@cf/nvidia/nemotron-3-120b-a12b`. No lleva API key propia ni proveedor externo (el Worker llama con su propia identidad). Esto está documentado en el README.

**¿Qué sigue pendiente?** Evaluar si en el futuro se quiere un proveedor diferente (OpenAI, Anthropic, etc.) para mayor control o menores costes. No hay prisa: la implementación actual funciona sin coste adicional.

## 4. Identidad: proveedor de autenticación (Google Sign-In o email+OTP)

**Estado:** Pendiente — decisión de arquitectura.

**Contexto:** Actualmente la identidad se ancla a la compra (Google Play token o Microsoft Store orderId). No hay cuentas ni contraseñas. El `email` es opcional y solo de índice inverso. Cuando se decida añadir login real (Google Sign-In o email+OTP), se añade el endpoint correspondiente en `src/routes/auth.ts` y se conserva `emitirSesion`.

**¿Qué se necesita para cerrar?**
- Decidir si se añade login real o se mantiene identidad anclada a compra.
- Si se añade: implementar endpoint, esquema de usuario ampliado, y migración de datos existentes.

**Bloqueador:** Ninguno. Es una decisión de producto sobre si el usuario necesita cuenta con contraseña o si la compra es suficiente.

## 5. Notificaciones push al usuario

**Estado:** Pendiente — mejora de UX, no bloqueante.

**Contexto:** Hoy la app solo consulta al abrirse y al volver del segundo plano. No hay notificaciones push cuando llega una respuesta del equipo ni aviso al equipo cuando el usuario escribe un mensaje.

**¿Qué se necesita para cerrar?**
- Añadir ajustes de watch del repo de soporte (GitHub notifications) para avisar al equipo.
- Implementar push notifications en la app móvil (Firebase Cloud Messaging o equivalente).

**Bloqueador:** Trabajo de frontend + configuración de notificaciones. No afecta al backend Worker.

## 6. Migración KV → D1 (consulta relacional)

**Estado:** Pendiente — mejora de arquitectura, no bloqueante.

**Contexto:** El Worker usa Cloudflare KV para el mapeo de tickets. La documentación del README señala que se debería migrar a D1 si se necesita consulta relacional más adelante (ej. consultar tickets por estado, fecha, severidad sin cargar todos en memoria).

**¿Qué se necesita para cerrar?**
- Evaluar si el volumen de tickets justifica D1.
- Migrar el almacenamiento de `Almacen` de KV a D1.
- Actualizar `docs/KV_SCHEMA.md` con el nuevo esquema.

**Bloqueador:** Trabajo de refactorización del backend. No afecta a la funcionalidad actual.

---

### Cómo usar este documento

Cuando se tome una decisión, mover la entrada correspondiente a un documento de "decisiones tomadas" y actualizar los archivos afectados (README, código, `.dev.vars.example`). Mantener este archivo sincronizado con el estado real de cada decisión.

### Referencias cruzadas

- `README.md` — stack, setup, endpoints, identidad, cómo funciona una incidencia
- `docs/KV_SCHEMA.md` — esquema completo de Cloudflare KV
- `CONTRIBUTING.md` — cómo contribuir al backend
- `TESTING.md` — guía de testing del Worker
