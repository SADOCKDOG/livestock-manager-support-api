/**
 * Estructuracion del reporte con IA.
 *
 * La IA convierte texto libre en un reporte con forma. NO diagnostica ni
 * propone parches de codigo: si aventura una causa, va como hipotesis y acaba
 * en un comentario del issue, nunca en el cuerpo principal ni como codigo.
 *
 * PENDIENTE DE DEFINIR: el proveedor. La implementacion usa la API de mensajes
 * de Anthropic por defecto; cambiar de proveedor solo deberia tocar
 * `llamarProveedor()`.
 */

import type { BorradorTicket, ContextoApp, Severidad } from '../types';
import { limpiarPasos, limpiarTexto, limpiarTitulo, LIMITES } from '../utils/sanitize';
import { detalleError } from '../utils/errores';

const MODELO = 'claude-sonnet-4-5';
const URL_PROVEEDOR = 'https://api.anthropic.com/v1/messages';
const VERSION_API = '2023-06-01';

const INSTRUCCIONES = `Eres el clasificador de incidencias de Livestock Manager, una app de gestion ganadera.
Recibes el texto libre de un ganadero y devuelves un reporte estructurado.

Reglas:
- Responde SOLO con JSON valido, sin texto alrededor ni bloques de codigo.
- Escribe en espanol de Espana, claro y sin tecnicismos innecesarios.
- No inventes datos que el usuario no haya dado. Si algo falta, omitelo.
- No propongas cambios de codigo, parches ni nombres de fichero.
- La severidad es "alta" solo si hay perdida de datos o la app no se puede usar.

Formato exacto:
{
  "titulo": "resumen en una linea, maximo 100 caracteres",
  "descripcion": "que ocurre, en 2-4 frases",
  "pasos_reproduccion": ["paso 1", "paso 2"],
  "severidad": "alta" | "media" | "baja",
  "posible_causa": "hipotesis breve, opcional"
}`;

const SEVERIDADES: Severidad[] = ['alta', 'media', 'baja'];

interface RespuestaProveedor {
  content?: Array<{ type: string; text?: string }>;
}

async function llamarProveedor(apiKey: string, mensaje: string): Promise<string> {
  const respuesta = await fetch(URL_PROVEEDOR, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': VERSION_API,
    },
    body: JSON.stringify({
      model: MODELO,
      max_tokens: 1024,
      system: INSTRUCCIONES,
      messages: [{ role: 'user', content: mensaje }],
    }),
  });

  if (!respuesta.ok) {
    // El codigo HTTP solo no distingue una clave invalida (401) de una sin
    // saldo (400) o de un limite de uso (429), y el borrador de reserva tapa
    // el fallo: el usuario recibe un ticket pobre y nadie se entera de por que.
    // Se recorta el cuerpo porque puede venir con eco de la peticion.
    let detalle = '';
    try {
      detalle = (await respuesta.text()).slice(0, 300);
    } catch {
      detalle = '(sin cuerpo)';
    }
    throw new Error(`El proveedor de IA respondio ${respuesta.status}: ${detalle}`);
  }
  const datos = (await respuesta.json()) as RespuestaProveedor;
  const texto = datos.content?.find((c) => c.type === 'text')?.text;
  if (!texto) throw new Error('El proveedor de IA devolvio una respuesta vacia');
  return texto;
}

/** Extrae el JSON aunque el modelo lo envuelva en un bloque de codigo. */
function extraerJSON(texto: string): Record<string, unknown> {
  const limpio = texto.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  const inicio = limpio.indexOf('{');
  const fin = limpio.lastIndexOf('}');
  if (inicio === -1 || fin === -1) throw new Error('La IA no devolvio JSON');
  return JSON.parse(limpio.slice(inicio, fin + 1)) as Record<string, unknown>;
}

/**
 * Reporte de reserva cuando la IA falla. Es preferible un ticket pobre pero
 * real que perder lo que el usuario acaba de escribir.
 */
function borradorDeReserva(ticketId: string, descripcion: string): BorradorTicket {
  const primeraLinea = descripcion.split('\n')[0] ?? 'Incidencia sin titulo';
  return {
    ticket_id: ticketId,
    titulo: limpiarTitulo(primeraLinea.slice(0, 100)),
    descripcion: limpiarTexto(descripcion, LIMITES.descripcion),
    pasos_reproduccion: [],
    severidad: 'media',
  };
}

export async function estructurarReporte(
  apiKey: string,
  ticketId: string,
  descripcionUsuario: string,
  contexto: ContextoApp,
): Promise<BorradorTicket> {
  const mensaje = [
    `Incidencia descrita por el usuario:\n${descripcionUsuario}`,
    '',
    'Contexto tecnico:',
    `- Version de la app: ${contexto.version_app ?? 'desconocida'}`,
    `- Plataforma: ${contexto.plataforma ?? 'desconocida'}`,
    `- Dispositivo: ${contexto.dispositivo ?? 'desconocido'}`,
  ].join('\n');

  let bruto: Record<string, unknown>;
  try {
    bruto = extraerJSON(await llamarProveedor(apiKey, mensaje));
  } catch (e) {
    console.warn('[ai] fallo la estructuracion, se usa el borrador de reserva:', detalleError(e));
    return borradorDeReserva(ticketId, descripcionUsuario);
  }

  const severidad = SEVERIDADES.includes(bruto.severidad as Severidad)
    ? (bruto.severidad as Severidad)
    : 'media';

  // Todo lo que devuelve la IA se limpia igual que si lo hubiera escrito el
  // usuario: puede haber repetido una inyeccion contenida en el texto original.
  const borrador: BorradorTicket = {
    ticket_id: ticketId,
    titulo: limpiarTitulo(bruto.titulo) || 'Incidencia sin titulo',
    descripcion:
      limpiarTexto(bruto.descripcion, LIMITES.descripcion) ||
      limpiarTexto(descripcionUsuario, LIMITES.descripcion),
    pasos_reproduccion: limpiarPasos(bruto.pasos_reproduccion),
    severidad,
  };

  const causa = limpiarTexto(bruto.posible_causa, LIMITES.causa);
  if (causa) borrador.posible_causa = causa;

  return borrador;
}
