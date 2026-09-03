/**
 * Sesion del usuario y comprobacion de licencia.
 *
 * Dos middleware separados a proposito:
 *  - `requiereSesion`: solo identifica. Sirve para consultar tickets propios.
 *  - `requiereLicencia`: ademas exige licencia de soporte activa. Solo para
 *     crear tickets, que es lo que cuesta dinero (IA) y es el producto de pago.
 *
 * Asi un usuario cuya licencia caduca sigue viendo el historial de lo que ya
 * reporto, pero no puede abrir nada nuevo.
 */

import type { Context, Next } from 'hono';
import { jwtVerify } from 'jose';
import { Almacen } from '../services/storage';
import type { Env, SesionJWT, Variables } from '../types';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const codificador = new TextEncoder();

export async function verificarSesion(
  token: string,
  secreto: string,
): Promise<SesionJWT | null> {
  try {
    const { payload } = await jwtVerify(token, codificador.encode(secreto), {
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string') return null;
    return {
      sub: payload.sub,
      email: String(payload.email ?? ''),
      // Lista blanca explicita: 'android' es el valor por defecto historico,
      // pero degradar 'windows' a 'android' archivaria las incidencias del
      // escritorio con la plataforma equivocada.
      plataforma: (payload.plataforma === 'web' || payload.plataforma === 'windows'
        ? payload.plataforma
        : 'android') as SesionJWT['plataforma'],
    };
  } catch {
    return null;
  }
}

/** Exige un JWT de sesion valido y deja el usuario en el contexto. */
export async function requiereSesion(c: Ctx, next: Next) {
  const cabecera = c.req.header('Authorization') ?? '';
  const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : '';
  if (!token) return c.json({ error: 'Falta el token de sesion' }, 401);

  const sesion = await verificarSesion(token, c.env.JWT_SECRET);
  if (!sesion) return c.json({ error: 'Sesion no valida o caducada' }, 401);

  const almacen = new Almacen(c.env.TICKETS_KV);
  const usuario = await almacen.obtenerUsuario(sesion.sub);
  if (!usuario) return c.json({ error: 'Usuario no encontrado' }, 401);

  c.set('sesion', sesion);
  c.set('usuario', usuario);
  await next();
}

/**
 * Exige licencia de soporte activa. Debe encadenarse DESPUES de requiereSesion.
 *
 * En desarrollo local (ENTORNO=development) se puede saltar para probar el
 * flujo sin compra real. Nunca debe definirse esa variable en produccion: el
 * endpoint gasta creditos de IA y crea issues.
 */
export async function requiereLicencia(c: Ctx, next: Next) {
  if (c.env.ENTORNO === 'development') {
    console.warn('[auth] ENTORNO=development: se omite la verificacion de licencia');
    await next();
    return;
  }

  const usuario = c.get('usuario');
  if (!usuario?.licencia_soporte_activa) {
    return c.json(
      {
        error: 'Necesitas una licencia de soporte activa',
        codigo: 'LICENCIA_INACTIVA',
      },
      403,
    );
  }

  if (usuario.licencia_expira && Date.parse(usuario.licencia_expira) < Date.now()) {
    return c.json(
      { error: 'Tu licencia de soporte ha caducado', codigo: 'LICENCIA_CADUCADA' },
      403,
    );
  }

  await next();
}
