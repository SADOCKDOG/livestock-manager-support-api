/**
 * Tipos compartidos del Worker de soporte.
 *
 * PRINCIPIO: este backend SOLO crea issues de GitHub. Nunca genera commits,
 * ramas ni pull requests. El mantenedor no aprueba nada; solo lee y responde.
 */

export interface Env {
  // --- Bindings ---
  TICKETS_KV: KVNamespace;

  // --- Variables publicas (wrangler.toml [vars]) ---
  GITHUB_REPO_OWNER: string;
  GITHUB_REPO_NAME: string;
  MAX_TICKETS_PER_DAY: string;
  /** Solo 'development' salta la verificacion de licencia. Nunca en produccion. */
  ENTORNO?: string;

  // --- Secretos (wrangler secret put) ---
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_WEBHOOK_SECRET: string;
  AI_API_KEY: string;
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: string;
  JWT_SECRET: string;
  /** Opcional: solo si se habilita el pago web para la PWA. */
  STRIPE_SECRET_KEY?: string;
}

/** Estados internos del ticket. Se traducen a espanol en la app. */
export type EstadoTicket = 'enviada' | 'revision' | 'curso' | 'resuelta';

export type Severidad = 'alta' | 'media' | 'baja';

/** Plataforma de origen: determina como se verifica la licencia. */
export type Plataforma = 'android' | 'web';

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
}

/** Registro de usuario en KV. */
export interface Usuario {
  user_id: string;
  email: string;
  plataforma: Plataforma;
  /** Token de compra de Play (android) o id de suscripcion de Stripe (web). */
  purchase_token?: string;
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
