/**
 * Endpoints de tickets.
 *
 * El flujo tiene dos pasos a proposito:
 *   POST /tickets          -> la IA estructura el reporte y devuelve un BORRADOR.
 *                             No se crea nada en GitHub todavia.
 *   POST /tickets/confirm  -> el usuario ha revisado (y quiza editado) el
 *                             borrador; ahora si se crea el issue.
 *
 * Ese segundo paso es el human-in-the-loop del diseno: quien valida es el
 * propio usuario que reporta, no el mantenedor. El mantenedor no aprueba nada.
 */

import { Hono } from 'hono';
import { estructurarReporte, redactarRespuestaInicial } from '../services/ai';
import { comentarIssue, crearIssue, reemplazarEtiquetaDeEstado } from '../services/github';
import { ACUSE_DE_RESERVA, comentarioDelAgente } from '../utils/agente';
import { Almacen } from '../services/storage';
import { requiereLicencia, requiereSesion } from '../middleware/auth';
import { limitarTickets } from '../middleware/rateLimit';
import { bloqueContexto, limpiarPasos, limpiarTexto, limpiarTitulo, LIMITES } from '../utils/sanitize';
import type { BorradorTicket, ContextoApp, Env, Severidad, Ticket, Variables } from '../types';
import { detalleError } from '../utils/errores';

const rutas = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Monta el cuerpo del issue a partir del borrador ya validado. */
function componerCuerpoIssue(
  descripcion: string,
  pasos: string[],
  contexto: ContextoApp,
  ticketId: string,
): string {
  const partes = [descripcion];

  if (pasos.length) {
    partes.push(
      '',
      '## Pasos para reproducirlo',
      ...pasos.map((p, i) => `${i + 1}. ${p}`),
    );
  }

  const bloque = bloqueContexto({
    'Version de la app': contexto.version_app,
    Plataforma: contexto.plataforma,
    Dispositivo: contexto.dispositivo,
    'Version del sistema': contexto.version_so,
    'Ticket interno': ticketId,
  });
  if (bloque) partes.push('', '## Contexto', bloque);

  partes.push(
    '',
    '---',
    '_Incidencia enviada desde la app y validada por la persona que la reporta._',
  );
  return partes.join('\n');
}

/**
 * Todo lo que el agente hace despues de crear el issue.
 *
 * Corre en `waitUntil`, fuera de la respuesta HTTP: son dos llamadas a la IA y
 * a GitHub que sumaban segundos a la espera del movil sin que el usuario gane
 * nada, porque el resultado le llega igualmente por el webhook.
 *
 * Nunca lanza. Si algo falla, el ticket ya esta creado y el mantenedor lo vera
 * en GitHub como siempre: el agente es un extra, no un eslabon del que dependa
 * que la incidencia exista.
 */
async function agenteResponde(
  env: Env,
  numeroIssue: number,
  borrador: BorradorTicket,
  contexto: ContextoApp,
): Promise<void> {
  try {
    // Si la IA no da nada util se publica el acuse fijo: el usuario merece
    // saber que su incidencia llego, aunque el modelo se haya caido.
    const texto = (await redactarRespuestaInicial(env.AI, borrador, contexto)) ?? ACUSE_DE_RESERVA;
    await comentarIssue(env, numeroIssue, comentarioDelAgente(texto));

    // La etiqueta va DESPUES del comentario. Al reves, el webhook del
    // etiquetado llegaria primero y el usuario veria «analizada» un rato antes
    // de tener nada que leer.
    await reemplazarEtiquetaDeEstado(env, numeroIssue, 'estado:enviada', 'estado:analizada');
  } catch (e) {
    console.warn('[tickets] el agente no pudo responder al issue', numeroIssue, detalleError(e));
  }
}

/**
 * Paso 1: estructurar. Gasta IA, asi que exige licencia y pasa por rate limit.
 * No crea nada en GitHub.
 */
rutas.post('/', requiereSesion, requiereLicencia, limitarTickets, async (c) => {
  const cuerpo = await c.req.json().catch(() => null);
  if (!cuerpo || typeof cuerpo.descripcion !== 'string') {
    return c.json({ error: 'Falta la descripcion de la incidencia' }, 400);
  }

  const descripcion = limpiarTexto(cuerpo.descripcion, LIMITES.descripcion);
  if (descripcion.length < 10) {
    return c.json({ error: 'Describe el problema con algo mas de detalle' }, 400);
  }

  const usuario = c.get('usuario');
  const ticketId = crypto.randomUUID();
  const contexto: ContextoApp = {
    version_app: cuerpo.contexto?.version_app,
    plataforma: usuario.plataforma,
    dispositivo: cuerpo.contexto?.dispositivo,
    version_so: cuerpo.contexto?.version_so,
  };

  const borrador = await estructurarReporte(
    c.env.AI,
    ticketId,
    descripcion,
    contexto,
  );

  const almacen = new Almacen(c.env.TICKETS_KV);
  await almacen.guardarBorrador(borrador, usuario.user_id);

  return c.json({ borrador, contexto });
});

/**
 * Paso 2: confirmar. Aqui si se crea el issue. Se aceptan las ediciones que el
 * usuario haya hecho sobre el borrador, limpiandolas de nuevo.
 */
rutas.post('/confirm', requiereSesion, requiereLicencia, limitarTickets, async (c) => {
  const cuerpo = await c.req.json().catch(() => null);
  const ticketId = cuerpo?.ticket_id;
  if (typeof ticketId !== 'string') {
    return c.json({ error: 'Falta el identificador del borrador' }, 400);
  }

  const usuario = c.get('usuario');
  const almacen = new Almacen(c.env.TICKETS_KV);
  const borrador = await almacen.obtenerBorrador(ticketId);

  if (!borrador) {
    return c.json({ error: 'El borrador ha caducado; vuelve a describir la incidencia' }, 404);
  }
  // Un borrador solo lo puede confirmar quien lo creo.
  if (borrador.user_id !== usuario.user_id) {
    return c.json({ error: 'Ese borrador no es tuyo' }, 403);
  }

  // El usuario puede haber editado el borrador: se vuelve a limpiar.
  const titulo = limpiarTitulo(cuerpo.titulo ?? borrador.titulo) || borrador.titulo;
  const descripcion =
    limpiarTexto(cuerpo.descripcion ?? borrador.descripcion, LIMITES.descripcion) ||
    borrador.descripcion;
  const pasos = cuerpo.pasos_reproduccion
    ? limpiarPasos(cuerpo.pasos_reproduccion)
    : borrador.pasos_reproduccion;
  const severidad: Severidad = borrador.severidad;

  const contexto: ContextoApp = {
    version_app: cuerpo.contexto?.version_app,
    plataforma: usuario.plataforma,
    dispositivo: cuerpo.contexto?.dispositivo,
    version_so: cuerpo.contexto?.version_so,
  };

  let numeroIssue: number;
  try {
    numeroIssue = await crearIssue(c.env, {
      titulo,
      cuerpo: componerCuerpoIssue(descripcion, pasos, contexto, ticketId),
      severidad,
    });
  } catch (e) {
    console.error('[tickets] fallo al crear el issue:', detalleError(e));
    return c.json({ error: 'No se pudo registrar la incidencia. Intentalo de nuevo.' }, 502);
  }

  // La hipotesis de la IA va aparte, como comentario: no es un diagnostico
  // confirmado y no debe leerse como parte del reporte del usuario.
  if (borrador.posible_causa) {
    await comentarIssue(
      c.env,
      numeroIssue,
      `**Hipotesis generada automaticamente** (sin verificar):\n\n${borrador.posible_causa}`,
    );
  }

  // El agente lee, contesta y marca la incidencia como analizada. Va en
  // segundo plano; la respuesta al movil no espera por el.
  c.executionCtx.waitUntil(
    agenteResponde(c.env, numeroIssue, { ...borrador, titulo, descripcion, pasos_reproduccion: pasos }, contexto),
  );

  const ahora = new Date().toISOString();
  const ticket: Ticket = {
    ticket_id: ticketId,
    github_issue_number: numeroIssue,
    user_id: usuario.user_id,
    estado: 'enviada',
    titulo,
    severidad,
    created_at: ahora,
    updated_at: ahora,
  };

  await almacen.guardarTicket(ticket);
  await almacen.incrementarContadorDelDia(usuario.user_id);
  await almacen.borrarBorrador(ticketId);

  // El numero de issue no se devuelve: el usuario nunca ve GitHub.
  return c.json({
    ticket_id: ticket.ticket_id,
    estado: ticket.estado,
    titulo: ticket.titulo,
    created_at: ticket.created_at,
  });
});

/** Listado de incidencias propias. No exige licencia: el historial sigue visible. */
rutas.get('/', requiereSesion, async (c) => {
  const usuario = c.get('usuario');
  const almacen = new Almacen(c.env.TICKETS_KV);
  const tickets = await almacen.listarTicketsDeUsuario(usuario.user_id);
  return c.json({
    tickets: tickets.map((t) => {
      const respuestas = t.respuestas ?? [];
      const ultima = respuestas[respuestas.length - 1];
      return {
        ticket_id: t.ticket_id,
        titulo: t.titulo,
        estado: t.estado,
        severidad: t.severidad,
        created_at: t.created_at,
        updated_at: t.updated_at,
        cerrada_at: t.cerrada_at ?? null,
        // El listado no manda el texto de las respuestas, solo cuantas hay y
        // la fecha de la ultima: con eso la app marca las no leidas sin
        // arrastrar el hilo entero de cada incidencia en cada carga.
        respuestas: respuestas.length,
        ultima_respuesta_at: ultima ? ultima.fecha : null,
      };
    }),
  });
});

rutas.get('/:id', requiereSesion, async (c) => {
  const usuario = c.get('usuario');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Falta el identificador' }, 400);

  const almacen = new Almacen(c.env.TICKETS_KV);
  const ticket = await almacen.obtenerTicket(id);

  // Mismo 404 si no existe o si es de otro usuario: no se filtra que exista.
  if (!ticket || ticket.user_id !== usuario.user_id) {
    return c.json({ error: 'Incidencia no encontrada' }, 404);
  }

  return c.json({
    ticket_id: ticket.ticket_id,
    titulo: ticket.titulo,
    estado: ticket.estado,
    severidad: ticket.severidad,
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
    cerrada_at: ticket.cerrada_at ?? null,
    // Aqui si va el hilo completo: es la pantalla donde el usuario lee lo que
    // le ha contestado el equipo.
    respuestas: ticket.respuestas ?? [],
  });
});

export default rutas;
