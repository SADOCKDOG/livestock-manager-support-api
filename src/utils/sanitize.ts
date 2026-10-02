/**
 * Limpieza del contenido antes de publicarlo en GitHub.
 *
 * Dos amenazas distintas:
 *  1. Lo que escribe el usuario: puede intentar inyectar markdown o HTML.
 *  2. Lo que devuelve la IA: puede repetir la inyeccion del usuario o inventar
 *     estructura. Nunca se publica tal cual.
 */

/** Longitudes maximas: un issue no necesita mas, y acotan el abuso. */
export const LIMITES = {
  titulo: 120,
  descripcion: 4000,
  paso: 300,
  pasos: 20,
  causa: 1000,
  mensaje: 2000,
} as const;

function escaparHtml(entrada: string): string {
  return entrada
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escapa HTML y neutraliza patrones de mención / referencia.
 *
 * La sanitizacion basada en regex para borrar etiquetas es frágil y CodeQL la
 * marca como peligrosa. Para este caso lo correcto es escapar HTML y tratar el
 * contenido como texto plano antes de publicarlo en GitHub.
 */
export function limpiarTexto(entrada: unknown, maximo: number): string {
  if (typeof entrada !== 'string') return '';

  let s = escaparHtml(entrada)
    .replace(/(^|\s)@([a-zA-Z0-9-]+)/g, '$1@$2')
    .replace(/(^|\s)#(\d+)/g, '$1#$2')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

  if (s.length > maximo) s = s.slice(0, maximo) + '…';
  return s;
}

/** El titulo va en una sola linea. */
export function limpiarTitulo(entrada: unknown): string {
  return limpiarTexto(entrada, LIMITES.titulo).replace(/\n+/g, ' ');
}

/** Los pasos se acotan en numero y longitud. */
export function limpiarPasos(entrada: unknown): string[] {
  if (!Array.isArray(entrada)) return [];
  return entrada
    .slice(0, LIMITES.pasos)
    .map((p) => limpiarTexto(p, LIMITES.paso).replace(/\n+/g, ' '))
    .filter((p) => p.length > 0);
}

/**
 * Envuelve el contexto tecnico en un bloque de codigo: aunque traiga algo raro,
 * dentro de un fence no se interpreta como markdown.
 */
export function bloqueContexto(datos: Record<string, unknown>): string {
  const lineas = Object.entries(datos)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${String(v).replace(/[`\n]/g, ' ').slice(0, 200)}`);
  if (!lineas.length) return '';
  return '```\n' + lineas.join('\n') + '\n```';
}
