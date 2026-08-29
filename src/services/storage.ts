/**
 * Persistencia en Cloudflare KV.
 *
 * Claves:
 *   usuario:<user_id>         -> Usuario
 *   email:<email>             -> user_id            (para el login)
 *   ticket:<ticket_id>        -> Ticket (incluye las respuestas del equipo)
 *   issue:<numero>            -> ticket_id          (para el webhook)
 *   tickets-usuario:<user_id> -> string[] (ticket_id, mas reciente primero)
 *   borrador:<ticket_id>      -> BorradorTicket     (TTL corto)
 *   ratelimit:<user_id>:<dia> -> contador
 *
 * KV es de consistencia eventual: sirve para el mapeo, pero como contador de
 * rate limiting puede burlarse con peticiones en paralelo. Si eso llega a
 * importar, el contador deberia moverse a Durable Objects o D1.
 */

import type {
  BorradorTicket,
  EstadoTicket,
  RespuestaTicket,
  Ticket,
  Usuario,
} from '../types';

/** El borrador solo tiene que sobrevivir a la confirmacion del usuario. */
const TTL_BORRADOR_SEGUNDOS = 60 * 30;

export class Almacen {
  constructor(private kv: KVNamespace) {}

  // --- Usuarios -------------------------------------------------------------

  async obtenerUsuario(userId: string): Promise<Usuario | null> {
    return this.kv.get<Usuario>(`usuario:${userId}`, 'json');
  }

  async obtenerUsuarioPorEmail(email: string): Promise<Usuario | null> {
    const userId = await this.kv.get(`email:${email.toLowerCase()}`, 'text');
    return userId ? this.obtenerUsuario(userId) : null;
  }

  async guardarUsuario(usuario: Usuario): Promise<void> {
    await this.kv.put(`usuario:${usuario.user_id}`, JSON.stringify(usuario));
    await this.kv.put(`email:${usuario.email.toLowerCase()}`, usuario.user_id);
  }

  // --- Borradores (previos a la confirmacion del usuario) -------------------

  async guardarBorrador(borrador: BorradorTicket, userId: string): Promise<void> {
    await this.kv.put(
      `borrador:${borrador.ticket_id}`,
      JSON.stringify({ ...borrador, user_id: userId }),
      { expirationTtl: TTL_BORRADOR_SEGUNDOS },
    );
  }

  async obtenerBorrador(
    ticketId: string,
  ): Promise<(BorradorTicket & { user_id: string }) | null> {
    return this.kv.get(`borrador:${ticketId}`, 'json');
  }

  async borrarBorrador(ticketId: string): Promise<void> {
    await this.kv.delete(`borrador:${ticketId}`);
  }

  // --- Tickets --------------------------------------------------------------

  async guardarTicket(ticket: Ticket): Promise<void> {
    await this.kv.put(`ticket:${ticket.ticket_id}`, JSON.stringify(ticket));
    if (ticket.github_issue_number !== null) {
      await this.kv.put(`issue:${ticket.github_issue_number}`, ticket.ticket_id);
    }
    const clave = `tickets-usuario:${ticket.user_id}`;
    const lista = (await this.kv.get<string[]>(clave, 'json')) ?? [];
    if (!lista.includes(ticket.ticket_id)) {
      lista.unshift(ticket.ticket_id);
      await this.kv.put(clave, JSON.stringify(lista.slice(0, 200)));
    }
  }

  async obtenerTicket(ticketId: string): Promise<Ticket | null> {
    return this.kv.get<Ticket>(`ticket:${ticketId}`, 'json');
  }

  async listarTicketsDeUsuario(userId: string, limite = 50): Promise<Ticket[]> {
    const ids = (await this.kv.get<string[]>(`tickets-usuario:${userId}`, 'json')) ?? [];
    const tickets = await Promise.all(
      ids.slice(0, limite).map((id) => this.obtenerTicket(id)),
    );
    return tickets.filter((t): t is Ticket => t !== null);
  }

  /**
   * Lo usa el webhook: aplica a un ticket lo que ha pasado en su issue.
   *
   * Estado y respuesta llegan juntos porque un mismo evento suele traer las
   * dos cosas (comentar mueve la incidencia a «en revision»), y separarlo en
   * dos escrituras de KV abriria una ventana en la que el usuario ve la
   * respuesta sin el estado nuevo, o al reves.
   *
   * Devuelve null si el issue no tiene ticket asociado: pasa con los issues
   * creados a mano en el repo, y no es un error.
   */
  async aplicarEventoDeIssue(
    numeroIssue: number,
    cambios: { estado?: EstadoTicket; respuesta?: RespuestaTicket },
  ): Promise<Ticket | null> {
    const ticketId = await this.kv.get(`issue:${numeroIssue}`, 'text');
    if (!ticketId) return null;
    const ticket = await this.obtenerTicket(ticketId);
    if (!ticket) return null;

    if (cambios.estado) {
      ticket.estado = cambios.estado;
      // La fecha de cierre se fija la primera vez y no se toca despues: si el
      // mantenedor reabre y vuelve a cerrar, interesa cuando quedo resuelta.
      if (cambios.estado === 'resuelta' && !ticket.cerrada_at) {
        ticket.cerrada_at = new Date().toISOString();
      }
      if (cambios.estado !== 'resuelta') ticket.cerrada_at = null;
    }

    if (cambios.respuesta) {
      const respuestas = ticket.respuestas ?? [];
      // Tope defensivo: KV admite 25 MB por valor, pero un hilo eterno no
      // aporta nada al usuario y engorda cada lectura del listado.
      respuestas.push(cambios.respuesta);
      ticket.respuestas = respuestas.slice(-50);
    }

    ticket.updated_at = new Date().toISOString();
    await this.kv.put(`ticket:${ticketId}`, JSON.stringify(ticket));
    return ticket;
  }

  // --- Rate limiting --------------------------------------------------------

  /** Devuelve el numero de tickets creados hoy por el usuario (UTC). */
  async contarTicketsDelDia(userId: string): Promise<number> {
    const dia = new Date().toISOString().slice(0, 10);
    const valor = await this.kv.get(`ratelimit:${userId}:${dia}`, 'text');
    return valor ? parseInt(valor, 10) || 0 : 0;
  }

  async incrementarContadorDelDia(userId: string): Promise<void> {
    const dia = new Date().toISOString().slice(0, 10);
    const clave = `ratelimit:${userId}:${dia}`;
    const actual = await this.contarTicketsDelDia(userId);
    // 48h de TTL: cubre el dia en curso con margen para husos horarios.
    await this.kv.put(clave, String(actual + 1), { expirationTtl: 60 * 60 * 48 });
  }
}
