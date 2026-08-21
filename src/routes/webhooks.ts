/**
 * Webhook de GitHub: mantiene sincronizado el estado del ticket.
 *
 * El mantenedor trabaja en GitHub con normalidad (etiqueta, comenta, cierra) y
 * el estado que ve el usuario en la app se actualiza solo. No hay ningun paso
 * de aprobacion: etiquetar un issue no "aprueba" nada, solo informa.
 *
 * Todo payload sin firma HMAC valida se descarta antes de tocar nada.
 */

import { Hono } from 'hono';
import { Almacen } from '../services/storage';
import { firmaWebhookValida } from '../utils/verifyWebhookSignature';
import type { EstadoTicket, Env, Variables } from '../types';

const rutas = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Etiqueta de GitHub -> estado interno. */
const ETIQUETA_A_ESTADO: Record<string, EstadoTicket> = {
  'estado:enviada': 'enviada',
  'estado:revision': 'revision',
  'estado:curso': 'curso',
  'estado:resuelta': 'resuelta',
};

interface PayloadIssue {
  action?: string;
  issue?: {
    number?: number;
    state?: string;
    labels?: Array<{ name?: string }>;
  };
}

/**
 * Deduce el estado a partir del evento. El cierre manda sobre las etiquetas:
 * si el mantenedor cierra el issue, para el usuario esta resuelta aunque nadie
 * haya puesto la etiqueta.
 */
function estadoDesdePayload(payload: PayloadIssue): EstadoTicket | null {
  const issue = payload.issue;
  if (!issue) return null;

  if (payload.action === 'closed' || issue.state === 'closed') return 'resuelta';
  if (payload.action === 'reopened') return 'curso';

  for (const etiqueta of issue.labels ?? []) {
    const estado = etiqueta.name ? ETIQUETA_A_ESTADO[etiqueta.name] : undefined;
    if (estado) return estado;
  }

  // Un comentario del mantenedor implica que alguien lo ha mirado.
  if (payload.action === 'created') return 'revision';
  return null;
}

rutas.post('/github', async (c) => {
  // Hay que firmar sobre el cuerpo crudo: reserializar el JSON cambia bytes y
  // la firma dejaria de coincidir.
  const crudo = await c.req.text();

  const valida = await firmaWebhookValida(
    crudo,
    c.req.header('X-Hub-Signature-256'),
    c.env.GITHUB_WEBHOOK_SECRET,
  );
  if (!valida) {
    console.warn('[webhook] firma no valida, descartado');
    return c.json({ error: 'Firma no valida' }, 401);
  }

  const evento = c.req.header('X-GitHub-Event');
  if (evento !== 'issues' && evento !== 'issue_comment') {
    return c.json({ ok: true, ignorado: evento });
  }

  let payload: PayloadIssue;
  try {
    payload = JSON.parse(crudo) as PayloadIssue;
  } catch {
    return c.json({ error: 'Payload no valido' }, 400);
  }

  const numero = payload.issue?.number;
  if (typeof numero !== 'number') return c.json({ ok: true, ignorado: 'sin numero' });

  const estado = estadoDesdePayload(payload);
  if (!estado) return c.json({ ok: true, ignorado: 'sin cambio de estado' });

  const almacen = new Almacen(c.env.TICKETS_KV);
  const ticket = await almacen.actualizarEstadoPorIssue(numero, estado);

  // Un issue creado a mano en el repo no tiene ticket asociado: no es un error.
  if (!ticket) return c.json({ ok: true, ignorado: 'issue sin ticket' });

  return c.json({ ok: true, ticket_id: ticket.ticket_id, estado });
});

export default rutas;
