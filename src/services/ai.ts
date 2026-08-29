/**
 * Estructuracion del reporte con IA.
 *
 * La IA convierte texto libre en un reporte con forma. NO diagnostica ni
 * propone parches de codigo: si aventura una causa, va como hipotesis y acaba
 * en un comentario del issue, nunca en el cuerpo principal ni como codigo.
 *
 * El proveedor es Workers AI, la inferencia que corre en la propia Cloudflare.
 * Se eligio frente a la API de Anthropic porque no lleva clave ni saldo: la
 * cuenta tenia la clave caducada y luego el saldo a cero, y cada incidencia
 * caia en el borrador de reserva. A cambio el modelo redacta algo peor, asi que
 * `extraerJSON()` y el borrador de reserva siguen siendo imprescindibles.
 *
 * Cambiar de proveedor solo deberia tocar `llamarProveedor()`.
 */

import type { BorradorTicket, ContextoApp, Severidad } from '../types';
import { limpiarPasos, limpiarTexto, limpiarTitulo, LIMITES } from '../utils/sanitize';
import { detalleError } from '../utils/errores';

// Modelo de Workers AI. El 70b cuantizado es el que mejor respeta un formato
// JSON pedido en el prompt sin dispararse de latencia; los de 8b se inventan
// campos con frecuencia y acaban en el borrador de reserva.
const MODELO = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

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

/**
 * Texto util de lo que devuelve Workers AI.
 *
 * Segun el modelo, `response` llega como cadena con el JSON dentro o como el
 * objeto ya parseado. Suponer solo lo primero costo un `TypeError: .trim is not
 * a function` que caia en el borrador de reserva sin decir por que. Se aceptan
 * las dos formas y, si llega una tercera, el error dice que forma tenia.
 */
function textoDeRespuesta(datos: unknown): string {
  if (typeof datos === 'string') return datos;

  const respuesta = (datos as { response?: unknown } | null)?.response;
  if (typeof respuesta === 'string') return respuesta;
  if (respuesta && typeof respuesta === 'object') return JSON.stringify(respuesta);

  throw new Error(
    'Workers AI devolvio una forma inesperada: ' + JSON.stringify(datos).slice(0, 200)
  );
}

async function llamarProveedor(ai: Ai, mensaje: string): Promise<string> {
  // `run` lanza si el modelo no existe o la cuenta agota su cuota diaria; el
  // catch de `estructurarReporte` lo registra con detalle y cae al de reserva.
  const datos = await ai.run(MODELO, {
    max_tokens: 1024,
    messages: [
      { role: 'system', content: INSTRUCCIONES },
      { role: 'user', content: mensaje },
    ],
  });

  const texto = textoDeRespuesta(datos).trim();
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
  ai: Ai,
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
    bruto = extraerJSON(await llamarProveedor(ai, mensaje));
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
