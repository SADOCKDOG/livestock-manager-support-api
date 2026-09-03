/**
 * Tipos compartidos del Worker de soporte.
 *
 * PRINCIPIO: este backend SOLO crea issues de GitHub. Nunca genera commits,
 * ramas ni pull requests. El mantenedor no aprueba nada; solo lee y responde.
 */

export interface Env {
  // --- Bindings ---
  TICKETS_KV: KVNamespace;
  /** Workers AI. Sustituye a la API de Anthropic: no lleva clave ni saldo. */
  AI: Ai;

  // --- Variables publicas (wrangler.toml [vars]) ---
  GITHUB_REPO_OWNER: string;
  GITHUB_REPO_NAME: string;
  MAX_TICKETS_PER_DAY: string;
  MAX_MENSAJES_PER_DAY?: string;
  /** Solo 'development' salta la verificacion de licencia. Nunca en produccion. */
  ENTORNO?: string;

  // --- Secretos (wrangler secret put) ---
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_WEBHOOK_SECRET: string;
  /**
   * OBSOLETO desde la migracion a Workers AI. El secreto sigue en Cloudflare
   * pero ya no lo lee nadie; se puede borrar sin efecto.
   */
  AI_API_KEY?: string;
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: string;
  JWT_SECRET: string;
  /** Opcional: solo si se habilita el pago web para la PWA. */
  STRIPE_SECRET_KEY?: string;
  /** Registro de aplicacion en Entra ID, para la API de colecciones de Microsoft. */
  MS_ENTRA_TENANT_ID?: string;
  MS_ENTRA_CLIENT_ID?: string;
  MS_ENTRA_CLIENT_SECRET?: string;
}

/**
 * Estados internos del ticket. Se traducen a espanol en la app.
 *
 * Van de menos a mas avanzado y ese orden importa: `RANGO_ESTADO` lo usa para
 * que el agente de IA nunca haga retroceder un ticket que una persona ya ha
 * movido. 'analizada' es el unico que pone la maquina: significa que el agente
 * lo ha leido y ha contestado, y que ninguna persona lo ha visto todavia.
 */
export type EstadoTicket = 'enviada' | 'analizada' | 'revision' | 'curso' | 'resuelta';

/** Progreso de cada estado. Solo se compara; los numeros no salen de aqui. */
export const RANGO_ESTADO: Record<EstadoTicket, number> = {
  enviada: 0,
  analizada: 1,
  revision: 2,
  curso: 3,
  resuelta: 4,
};

export type Severidad = 'alta' | 'media' | 'baja';

/** Plataforma de origen: determina como se verifica la licencia. */
export type Plataforma = 'android' | 'web' | 'windows';

/**
 * Respuesta a una incidencia.
 *
 * Nace de un comentario en el issue, pero el usuario nunca ve GitHub: no se
 * guarda ni el login del autor ni el numero del comentario, solo lo que hay
 * que ensenar. La hipotesis tecnica de la IA no llega hasta aqui: se filtra en
 * el webhook por no llevar el marcador del agente.
 */
export interface RespuestaTicket {
  /** ISO 8601. */
  fecha: string;
  texto: string;
  /** true si acompana al cierre de la incidencia. */
  cierre?: boolean;
  /**
   * Quien escribe. La app lo rotula distinto porque no es lo mismo: 'ia' es un
   * primer analisis automatico y 'equipo' es una persona. Opcional porque los
   * tickets anteriores al agente no lo tienen; al leerlo, ausente = 'equipo',
   * que es lo que eran todas las respuestas hasta ahora.
   */
  autor?: 'ia' | 'equipo' | 'usuario';
}

/** Registro de ticket en KV. */
export interface Ticket {
  ticket_id: string;
  github_issue_number: number | null;
  user_id: string;
  estado: EstadoTicket;
  titulo: string;
  severidad: Severidad;
  created_at: string;
  updated_at: string;
  /**
   * Respuestas del equipo, de la mas antigua a la mas reciente. Opcional
   * porque los tickets creados antes de esta funcionalidad no la tienen:
   * leerla siempre con `?? []`.
   */
  respuestas?: RespuestaTicket[];
  /** ISO 8601 del cierre. Solo se rellena al pasar a `resuelta`. */
  cerrada_at?: string | null;
  /**
   * ISO 8601 del momento en que el usuario confirmo que la solucion le
   * funciona. `resuelta` la pone el equipo, asi que hasta que este campo
   * tenga valor es una propuesta de resolucion, no un cierre aceptado: la
   * app se apoya en el para ofrecer «si, resuelto» o «sigue sin funcionar».
   */
  confirmada_at?: string | null;
}

/** Registro de usuario en KV. */
export interface Usuario {
  user_id: string;
  email: string;
  plataforma: Plataforma;
  /**
   * Token de compra de Play (android) o, en windows, el orderId de la compra en
   * Microsoft Store. En windows NO es un secreto reutilizable: la prueba de
   * compra es la Store ID key, que caduca a los 30 dias y se pide de nuevo.
   */
  purchase_token?: string;
  /**
   * Identificador de la instalacion de la app, generado en el dispositivo y
   * guardado en el almacen `meta` de IndexedDB, asi que viaja en la copia de
   * seguridad. Sirve para reencontrar al mismo usuario cuando Google emite un
   * purchase_token nuevo (recompra tras caducar, cambio de plan), que de otro
   * modo daria un user_id distinto y dejaria el historial huerfano.
   */
  instalacion_id?: string | null;
  licencia_soporte_activa: boolean;
  /** ISO 8601. null = compra unica sin caducidad. */
  licencia_expira: string | null;
}

/** Borrador estructurado por la IA, antes de que el usuario lo confirme. */
export interface BorradorTicket {
  ticket_id: string;
  titulo: string;
  descripcion: string;
  pasos_reproduccion: string[];
  severidad: Severidad;
  /** Hipotesis tecnica de la IA. Va como comentario, nunca como codigo. */
  posible_causa?: string;
}

/** Contexto del dispositivo que acompana al reporte. */
export interface ContextoApp {
  version_app?: string;
  plataforma?: Plataforma;
  dispositivo?: string;
  version_so?: string;
}

/** Payload de la sesion (JWT). */
export interface SesionJWT {
  sub: string; // user_id
  email: string;
  plataforma: Plataforma;
}

/** Variables que los middleware dejan disponibles en el contexto de Hono. */
export interface Variables {
  usuario: Usuario;
  sesion: SesionJWT;
}
