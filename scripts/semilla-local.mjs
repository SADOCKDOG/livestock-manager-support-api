/**
 * semilla-local.mjs — siembra una sesion de usuario en el Worker LOCAL.
 *
 * Para que el flujo de soporte se pueda probar en `wrangler dev` hace falta lo
 * mismo que en produccion: un JWT firmado con JWT_SECRET y su ficha en KV. Sin
 * las dos cosas, `requiereSesion` responde 401 «Usuario no encontrado» porque
 * solo salta la licencia con ENTORNO=development, nunca la sesion.
 *
 * NO sirve para produccion: se firma con el JWT_SECRET de `.dev.vars`, que es
 * distinto del desplegado, y ademas no verifica ninguna compra. Sirve para lo
 * que dice: abrir sesion en local y recorrer el ciclo de incidencias.
 *
 *   node scripts/semilla-local.mjs [--email correo@ejemplo.com] [--order-id X]
 *
 * Imprime el user_id y el JWT, y los comandos de `wrangler kv key put` ya
 * redactados para sembrar el KV local.
 */

import { createHmac, createHash } from 'node:crypto';

const arg = (nombre, defecto) => {
  const i = process.argv.indexOf(`--${nombre}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : defecto;
};

// El mismo secreto que .dev.vars. Si se cambia alli, se cambia aqui: un JWT
// firmado con otro secreto daria 401 «Sesion no valida» sin explicar por que.
const JWT_SECRET =
  arg('secreto', 'local-desarrollo-no-es-produccion-cambiar-si-se-publica');

const EMAIL = arg('email', 'yo@sadockdog.es');
const PLATAFORMA = arg('plataforma', 'windows');
// El order_id es lo que firma Microsoft. En local se inventa uno estable para
// que el user_id sea siempre el mismo entre ejecuciones.
const ORDER_ID = arg('order-id', 'local-order-id-0001');
const INSTALACION = arg('instalacion', 'inst-local-0001');

/** Igual que hashDe() de src/routes/auth.ts: SHA-256 y los 16 primeros bytes. */
async function hashDe(texto) {
  const digest = createHash('sha256').update(texto, 'utf8').digest();
  return [...digest.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Mismo esquema que hashUserIdWindows(): prefijo 'ms:' para no colisionar con Android. */
const userId = await hashDe(`usuario:ms:${ORDER_ID}`);

const base64url = (buf) => Buffer.from(buf).toString('base64url');
const cabecera = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const ahora = Math.floor(Date.now() / 1000);
const expira = ahora + 24 * 3600;
const payload = base64url(
  JSON.stringify({
    email: EMAIL,
    plataforma: PLATAFORMA,
    sub: userId,
    iat: ahora,
    exp: expira,
  }),
);
const firma = createHmac('sha256', JWT_SECRET)
  .update(`${cabecera}.${payload}`)
  .digest('base64url');
const token = `${cabecera}.${payload}.${firma}`;

const usuario = {
  user_id: userId,
  email: EMAIL,
  plataforma: PLATAFORMA,
  purchase_token: ORDER_ID,
  instalacion_id: INSTALACION,
  licencia_soporte_activa: true,
  // Sin caducidad: si expira, /auth/me la da por vencida y con ella cae todo
  // lo que se prueba, que no es lo que se quiere al sembrar una sesion de prueba.
  licencia_expira: null,
};

console.log(JSON.stringify({ usuario, token }, null, 2));
console.log(`
# Sembrar el KV local (--local: NUNCA toca el KV de produccion)
npx wrangler kv key put --binding TICKETS_KV --local "usuario:${userId}" '${JSON.stringify(usuario)}'
npx wrangler kv key put --binding TICKETS_KV --local "email:${EMAIL.toLowerCase()}" "${userId}"
npx wrangler kv key put --binding TICKETS_KV --local "instalacion:${INSTALACION}" "${userId}"
`);
