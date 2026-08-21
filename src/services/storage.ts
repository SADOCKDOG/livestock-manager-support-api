/**
 * Persistencia en Cloudflare KV.
 *
 * Claves:
 *   usuario:<user_id>         -> Usuario
 *   email:<email>             -> user_id            (para el login)
 *   ticket:<ticket_id>        -> Ticket
 *   issue:<numero>            -> ticket_id          (para el webhook)
 *   tickets-usuario:<user_id> -> string[] (ticket_id, mas reciente primero)
 *   borrador:<ticket_id>      -> BorradorTicket     (TTL corto)
 *   ratelimit:<user_id>:<dia> -> contador
 *
 * KV es de consistencia eventual: sirve para el mapeo, pero como contador de
 * rate limiting puede burlarse con peticiones en paralelo. Si eso llega a
 * importar, el contador deberia moverse a Durable Objects o D1.
 */

import type { BorradorTicket, EstadoTicket, Ticket, Usuario } from '../types';

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

  /** Lo usa el webhook: de numero de issue a ticket interno. */
  async actualizarEstadoPorIssue(
    numeroIssue: number,
    estado: EstadoTicket,
  ): Promise<Ticket | null> {
    const ticketId = await this.kv.get(`issue:${numeroIssue}`, 'text');
    if (!ticketId) return null;
    const ticket = await this.obtenerTicket(ticketId);
    if (!ticket) return null;
    ticket.estado = estado;
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
