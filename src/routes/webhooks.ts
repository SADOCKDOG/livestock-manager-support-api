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
import { esDelAgente, textoSinMarcador } from '../utils/agente';
import { firmaWebhookValida } from '../utils/verifyWebhookSignature';
import type { EstadoTicket, Env, RespuestaTicket, Variables } from '../types';

const rutas = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Etiqueta de GitHub -> estado interno. */
const ETIQUETA_A_ESTADO: Record<string, EstadoTicket> = {
  'estado:enviada': 'enviada',
  'estado:analizada': 'analizada',
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
 * Comentario publicado por la GitHub App. GitHub marca a las Apps con
 * `type: 'Bot'` y con el sufijo `[bot]` en el login; se comprueban las dos
 * cosas porque el `type` no viene en todos los payloads.
 */
function esDeLaApp(comentario: Comentario | undefined): boolean {
  const usuario = comentario?.user;
  if (!usuario) return false;
  if (usuario.type === 'Bot') return true;
  return (usuario.login ?? '').endsWith('[bot]');
}

/**
 * Comentarios que el usuario NO debe ver.
 *
 * La App publica dos cosas por el mismo canal: la hipotesis tecnica de la IA,
 * que es una conjetura sin revisar y no puede llegar a la pantalla del
 * ganadero como si se la hubiera escrito alguien, y la respuesta del agente,
 * que si es para el. Por autor son identicas, asi que se distinguen por el
 * marcador del cuerpo (ver `utils/agente.ts`, donde esta el porque).
 *
 * Todo lo que escribe una persona pasa siempre.
 */
/**
 * Comentarios de la App que el usuario NO debe ver: la hipotesis tecnica de la
 * IA y el eco de sus propios mensajes (que la app ya guardo al enviarlos). Se
 * distinguen de la respuesta del agente por el marcador, que nadie mas puede
 * escribir porque limpiarTexto() borra los comentarios HTML.
 */
function esComentarioOculto(comentario: Comentario | undefined): boolean {
  return esDeLaApp(comentario) && !esDelAgente(comentario?.body);
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

  const comentarioNuevo = evento === 'issue_comment' && payload.action === 'created';

  // Un comentario de una persona implica que alguien lo ha mirado de verdad.
  // Antes esto se deducia de `action === 'created'` sin mirar el evento, asi
  // que cualquier accion llamada igual movia el estado sin motivo.
  const comentarioDePersona = comentarioNuevo && !esDeLaApp(payload.comment);

  // El comentario gana a las etiquetas que pone la maquina, y solo a esas: las
  // pone el propio Worker, no son una decision del mantenedor, y mientras
  // siguieran puestas el estado quedaba congelado por mucho que se respondiera.
  // El resto si mandan: son deliberadas.
  const etiquetaAutomatica = porEtiqueta === null || porEtiqueta === 'enviada' || porEtiqueta === 'analizada';
  if (comentarioDePersona && etiquetaAutomatica) return 'revision';

  // La respuesta del agente deja la incidencia «analizada», nunca «revision»:
  // decir que el equipo la esta mirando cuando solo la ha leido un modelo seria
  // mentirle al usuario. `aplicarEventoDeIssue` impide ademas que este estado
  // haga retroceder un ticket que una persona ya habia movido.
  if (comentarioNuevo && esDelAgente(payload.comment?.body) && etiquetaAutomatica) {
    return 'analizada';
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
  if (esComentarioOculto(payload.comment)) return null;

  const cuerpo = payload.comment?.body ?? '';
  const delAgente = esDelAgente(cuerpo);
  // Del agente se guarda el texto sin el marcador ni el encabezado: la app ya
  // rotula quien responde y repetirlo en pantalla sobra.
  const texto = (delAgente ? textoSinMarcador(cuerpo) : cuerpo).trim();
  if (!texto) return null;

  return {
    fecha: new Date().toISOString(),
    // Un comentario sobre un issue ya cerrado es la explicacion del cierre.
    // El agente responde al abrirla, asi que nunca cae en este caso.
    cierre: !delAgente && payload.issue?.state === 'closed',
    autor: delAgente ? 'ia' : 'equipo',
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
