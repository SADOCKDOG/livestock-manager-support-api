/**
 * Identidad del agente de IA en los comentarios del issue.
 *
 * EL PROBLEMA. El Worker publica dos cosas muy distintas con la MISMA identidad
 * de GitHub (la App): la hipotesis tecnica sin verificar, que el usuario no debe
 * ver nunca, y la respuesta del agente, que si. El webhook filtra por autor
 * (`esDelBot`), asi que por autor son indistinguibles.
 *
 * LA SOLUCION. Un marcador en el propio cuerpo del comentario. Se descarto una
 * segunda identidad de GitHub (otra App, otra clave privada, otro secreto que
 * rotar) porque el coste de operacion no compensa, y tambien enrutar por
 * etiquetas, que obliga a un segundo evento y deja el estado inconsistente
 * entre medias.
 *
 * POR QUE NO SE PUEDE FALSIFICAR. `limpiarTexto()` borra los comentarios HTML
 * de todo lo que escriben el usuario y la IA antes de publicarlo. Un reporte
 * que traiga este marcador escrito a mano llega a GitHub sin el. Solo puede
 * ponerlo el Worker, que es quien lo anade despues de limpiar.
 *
 * Va como comentario HTML porque en GitHub no se ve: el mantenedor lee la
 * respuesta tal cual, sin ruido.
 */

/** Primera linea de todo comentario del agente. Invisible en GitHub. */
export const MARCADOR_AGENTE = '<!-- livestock:respuesta-agente -->';

/**
 * Encabezado visible. La app tambien rotula el autor, pero el comentario tiene
 * que decir lo que es tambien en GitHub, donde no hay rotulo que valga.
 */
const ENCABEZADO =
  'Respuesta automatica del asistente de soporte (todavia no la ha visto una persona):';

/**
 * Acuse cuando la IA falla. Es corto y no afirma nada que no sea cierto: es
 * preferible a dejar la incidencia sin ninguna senal de vida.
 */
export const ACUSE_DE_RESERVA =
  'Hemos recibido tu incidencia y ya esta registrada. El equipo la revisara y te respondera por aqui.';

/** Cuerpo del comentario listo para publicar. */
export function comentarioDelAgente(texto: string): string {
  return [MARCADOR_AGENTE, ENCABEZADO, '', texto].join('\n');
}

/** True si el comentario lo escribio el agente (y no la hipotesis del bot). */
export function esDelAgente(cuerpo: string | undefined): boolean {
  return (cuerpo ?? '').trimStart().startsWith(MARCADOR_AGENTE);
}

/**
 * Texto que ve el usuario: sin el marcador y sin el encabezado, porque la app
 * ya rotula quien responde y repetirlo en pantalla sobra.
 *
 * Se quitan por comparacion literal, linea a linea, en vez de con una expresion
 * regular construida a partir del encabezado: el texto lleva parentesis y dos
 * puntos, y escaparlos para meterlos en una regex es una fuente de errores que
 * aqui no compra nada.
 */
export function textoSinMarcador(cuerpo: string): string {
  const lineas = cuerpo.trimStart().split('\n');
  if (lineas[0]?.trim() === MARCADOR_AGENTE) lineas.shift();
  if (lineas[0]?.trim() === ENCABEZADO) lineas.shift();
  return lineas.join('\n').trim();
}
