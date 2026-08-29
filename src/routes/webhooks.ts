/**
 * Webhook de GitHub: mantiene sincronizado el estado del ticket y trae al
 * usuario las respuestas del equipo.
 *
 * El mantenedor trabaja en GitHub con normalidad (etiqueta, comenta, cierra) y
 * la app se actualiza sola. No hay ningun paso de aprobacion: etiquetar un
 * issue no "aprueba" nada, solo informa.
 *
 * Todo payload sin firma HMAC valida se descarta antes de tocar nada.
 */

import { Hono } from 'hono';
import { Almacen } from '../services/storage';
import { firmaWebhookValida } from '../utils/verifyWebhookSignature';
import type { EstadoTicket, Env, RespuestaTicket, Variables } from '../types';

const rutas = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Etiqueta de GitHub -> estado interno. */
const ETIQUETA_A_ESTADO: Record<string, EstadoTicket> = {
  'estado:enviada': 'enviada',
  'estado:revision': 'revision',
  'estado:curso': 'curso',
  'estado:resuelta': 'resuelta',
};

/** Lo que se lee de un comentario. El resto del payload no interesa. */
interface Comentario {
  body?: string;
  user?: { login?: string; type?: string };
}

interface PayloadIssue {
  action?: string;
  issue?: {
    number?: number;
    state?: string;
    labels?: Array<{ name?: string }>;
  };
  comment?: Comentario;
}

/**
 * Un comentario del propio bot no es una respuesta del equipo.
 *
 * La App publica la hipotesis tecnica de la IA como comentario, y sin este
 * filtro el usuario la veria como si se la hubiera escrito una persona: es
 * justo lo contrario de lo que se pretende, porque es una conjetura sin
 * revisar. GitHub marca a las Apps con `type: 'Bot'` y con el sufijo `[bot]`
 * en el login; se comprueban las dos cosas porque el `type` no viene en todos
 * los payloads.
 */
function esDelBot(comentario: Comentario | undefined): boolean {
  const usuario = comentario?.user;
  if (!usuario) return false;
  if (usuario.type === 'Bot') return true;
  return (usuario.login ?? '').endsWith('[bot]');
}

/**
 * Estado que deja el evento. El cierre manda sobre las etiquetas: si el
 * mantenedor cierra el issue, para el usuario esta resuelta aunque nadie haya
 * puesto la etiqueta.
 */
function estadoDesdePayload(payload: PayloadIssue, evento: string): EstadoTicket | null {
  const issue = payload.issue;
  if (!issue) return null;

  if (payload.action === 'closed' || issue.state === 'closed') return 'resuelta';
  if (payload.action === 'reopened') return 'curso';

  let porEtiqueta: EstadoTicket | null = null;
  for (const etiqueta of issue.labels ?? []) {
    const estado = etiqueta.name ? ETIQUETA_A_ESTADO[etiqueta.name] : undefined;
    if (estado) {
      porEtiqueta = estado;
      break;
    }
  }

  // Un comentario de una persona implica que alguien lo ha mirado. Antes esto
  // se deducia de `action === 'created'` sin mirar el evento, asi que
  // cualquier accion llamada igual movia el estado sin motivo.
  const comentarioDePersona =
    evento === 'issue_comment' &&
    payload.action === 'created' &&
    !esDelBot(payload.comment);

  // El comentario gana a la etiqueta `estado:enviada`, y solo a esa. La pone
  // el bot al crear el issue, no es una decision del mantenedor, y mientras
  // siguiera puesta el estado quedaba congelado en «enviada» por mucho que se
  // respondiera. El resto de etiquetas si mandan: son deliberadas.
  if (comentarioDePersona && (porEtiqueta === null || porEtiqueta === 'enviada')) {
    return 'revision';
  }
  return porEtiqueta;
}

/** Texto de la respuesta, si el evento trae una que el usuario deba ver. */
function respuestaDesdePayload(
  payload: PayloadIssue,
  evento: string,
): RespuestaTicket | null {
  // Editar o borrar un comentario no se propaga: el usuario ya lo ha leido y
  // hacerlo desaparecer de su historial confunde mas de lo que arregla.
  if (evento !== 'issue_comment' || payload.action !== 'created') return null;
  if (esDelBot(payload.comment)) return null;

  const texto = (payload.comment?.body ?? '').trim();
  if (!texto) return null;

  return {
    fecha: new Date().toISOString(),
    // Un comentario sobre un issue ya cerrado es la explicacion del cierre.
    cierre: payload.issue?.state === 'closed',
    // Tope generoso: caben varios parrafos y evita que un volcado de logs
    // pegado en GitHub se cuele entero en KV y en la pantalla del movil.
    texto: texto.slice(0, 4000),
  };
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

  const estado = estadoDesdePayload(payload, evento);
  const respuesta = respuestaDesdePayload(payload, evento);
  if (!estado && !respuesta) return c.json({ ok: true, ignorado: 'sin cambios' });

  const almacen = new Almacen(c.env.TICKETS_KV);
  const ticket = await almacen.aplicarEventoDeIssue(numero, {
    estado: estado ?? undefined,
    respuesta: respuesta ?? undefined,
  });

  // Un issue creado a mano en el repo no tiene ticket asociado: no es un error.
  if (!ticket) return c.json({ ok: true, ignorado: 'issue sin ticket' });

  return c.json({
    ok: true,
    ticket_id: ticket.ticket_id,
    estado: ticket.estado,
    respuestas: (ticket.respuestas ?? []).length,
  });
});

export default rutas;
