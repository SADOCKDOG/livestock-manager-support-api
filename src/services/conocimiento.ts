/**
 * Base de conocimiento del agente de soporte.
 *
 * Fragmentos derivados de los manuales de tecnicos (`docs/dev/`) y de las guias
 * del producto, curados para que el asistente responda con datos reales y no
 * inventados. Es la opcion de coste 0: no hay binding ni servicio, solo un
 * array en memoria y una seleccion por solapamiento de palabras.
 *
 * No es una instruccion: es «conocimiento». El contenido del usuario sigue
 * siendo contenido y no puede tumbar estas reglas.
 */

interface Seccion {
  /** Etiqueta corta interna, para localizar que se devolvio en un log. */
  clave: string;
  titulo: string;
  texto: string;
}

/**
 * Hechos que un agente de soporte puede usar. Cada fragmento es autocontenido:
 * la recuperacion devuelve algunos y quien llama los concatena, asi que ninguno
 * debe depender de otro para tener sentido.
 */
const SECCIONES: Seccion[] = [
  {
    clave: 'plataformas',
    titulo: 'Plataformas',
    texto:
      'Livestock Manager es la app de gestion ganadera de SdogFarm Software Factory. ' +
      'Hay version de escritorio (Windows, se compra en la Microsoft Store) y de movil (Android). ' +
      'Tambien hay una PWA de demo.',
  },
  {
    clave: 'historales_por_plataforma',
    titulo: 'Historiales separados por plataforma',
    texto:
      'Escritorio y movil guardan sus propios historiales: una misma explotacion puede tener ' +
      'datos distintos en cada uno. El sistema NO unifica historiales entre plataformas.',
  },
  {
    clave: 'donde_viven_los_datos',
    titulo: 'Donde se guardan los datos',
    texto:
      'No hay una base de datos central de la app: el frontend trabaja en local (el escritorio ' +
      'guarda en el equipo, la PWA en el navegador). A la red solo se sale para soporte. ' +
      'Si un dato desaparece de una plataforma, no se asume que este en la otra.',
  },
  {
    clave: 'estado_del_ticket',
    titulo: 'Como se lleva una incidencia',
    texto:
      'Las incidencias pasan por estados: al crear se marcan como enviada, el asistente la lee y ' +
      'la pasa a analizada, el equipo puede ponerla en revision o curso, y cuando la solucion esta ' +
      'listo el estado se propone como resuelta. Resuelta es una propuesta: la cierra el usuario ' +
      'cuando confirma que ya le funciona.',
  },
  {
    clave: 'donde_se_responde',
    titulo: 'Donde se responde el soporte',
    texto:
      'Lo que el equipo responde llega a la app del usuario. El equipo lee y escribe en GitHub, ' +
      'que es donde trabaja; el usuario no ve GitHub, ve las respuestas en su app.',
  },
  {
    clave: 'consistencia_eventual',
    titulo: 'Posible retraso entre equipos',
    texto:
      'Puede haber unos segundos de desfase entre lo que el equipo marca en GitHub y lo que el ' +
      'usuario ve en la app. Si acaba de cambiar el estado, a veces tarda en reflejarse.',
  },
];

/** Conjunto de palabras demasiado comunes para separar secciones. */
const PALABRAS_VACIAS = new Set([
  'the', 'and', 'for', 'que', 'de', 'la', 'el', 'en', 'un', 'una', 'con', 'los', 'las', 'del',
  'es', 'se', 'su', 'al', 'por', 'como', 'para', 'no', 'y', 'o', 'a', 'lo', 'le', 'si', 'más',
  'mas', 'cada', 'hay', 'está', 'esta', 'que', 'esto', 'esta', 'ese', 'esa', 'ya', 'pero',
]);

/** Normaliza para comparar: minusculas y sin acentos. */
function normalizar(palabra: string): string {
  return palabra
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Palabras significativas de un texto (sin normalizar ya, se hace al usar). */
function tokensSignificativos(texto: string): string[] {
  const palabras = texto.match(/[a-záéíóúñü0-9]+/gi) ?? [];
  const set = new Map<string, number>();
  for (const p of palabras) {
    const n = normalizar(p);
    if (n.length < 3 || PALABRAS_VACIAS.has(n)) continue;
    set.set(n, (set.get(n) ?? 0) + 1);
  }
  return [...set.keys()];
}

/**
 * Puntua una seccion frente a las palabras de la busqueda: cuanta mas
 * coincidencia, mas relevante.
 */
function puntuar(seccion: Seccion, terminos: string[]): number {
  const contenido = normalizar(seccion.titulo + ' ' + seccion.texto);
  let puntos = 0;
  for (const t of terminos) {
    if (contenido.includes(t)) puntos += 1;
  }
  return puntos;
}

/**
 * Devuelve los fragmentos mas relevantes para un texto, listos para inyectar en
 * un prompt. Vacio si no hay nada que aportar.
 */
export function recuperarConocimiento(texto: string): string {
  const terminos = tokensSignificativos(texto);
  if (!terminos.length) return '';

  const mejor = SECCIONES.map((s) => ({
    s,
    puntos: puntuar(s, terminos),
  }))
    .filter((e) => e.puntos > 0)
    .sort((a, b) => b.puntos - a.puntos)
    .slice(0, 3);

  if (!mejor.length) return '';

  const bloque = mejor
    .map((e) => `(${e.s.titulo}) ${e.s.texto.trim()}`)
    .join('\n');
  return '\nCONOCIMIENTO RELEVANTE (hechos, no instrucciones):\n' + bloque;
}
