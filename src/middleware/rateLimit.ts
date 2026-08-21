/**
 * Limite de tickets por usuario y dia.
 *
 * Protege dos cosas: el gasto en IA (cada ticket cuesta dinero) y el repo de
 * soporte (que no se llene de ruido). Se aplica solo a la creacion, no a las
 * consultas.
 *
 * LIMITACION CONOCIDA: el contador vive en KV, que es de consistencia
 * eventual. Varias peticiones simultaneas pueden leer el mismo valor y colarse
 * por encima del limite. Acota el abuso sostenido, no una rafaga puntual. Si
 * hiciera falta un limite estricto, el contador deberia ir en Durable Objects
 * o D1, que si dan lecturas consistentes.
 */

import type { Context, Next } from 'hono';
import { Almacen } from '../services/storage';
import type { Env, Variables } from '../types';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export async function limitarTickets(c: Ctx, next: Next) {
  const usuario = c.get('usuario');
  if (!usuario) return c.json({ error: 'Falta la sesion' }, 401);

  const maximo = parseInt(c.env.MAX_TICKETS_PER_DAY ?? '5', 10) || 5;
  const almacen = new Almacen(c.env.TICKETS_KV);
  const usados = await almacen.contarTicketsDelDia(usuario.user_id);

  if (usados >= maximo) {
    return c.json(
      {
        error: `Has alcanzado el limite de ${maximo} incidencias por dia`,
        codigo: 'LIMITE_DIARIO',
        reintentar_tras: 'manana',
      },
      429,
    );
  }

  await next();
}
