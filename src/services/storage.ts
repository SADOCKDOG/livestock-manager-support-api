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
 *   ratelimit:msticket:<ip>:<hora> -> contador
 *
 * KV es de consistencia eventual: sirve para el mapeo, pero como contador de
 * rate limiting puede burlarse con peticiones en paralelo. Si eso llega a
 * importar, el contador deberia moverse a Durable Objects o D1.
 */

import { RANGO_ESTADO } from '../types';
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
    // Sin este guardia, los usuarios sin correo compartian todos la clave
    // `email:` y el ultimo en registrarse se llevaba la de los demas.
    if (usuario.email) {
      await this.kv.put(`email:${usuario.email.toLowerCase()}`, usuario.user_id);
    }
  }

  /**
   * user_id al que quedo vinculada una instalacion de la app. Es lo que permite
   * reconocer al mismo ganadero cuando Google le da un purchase_token nuevo.
   */
  async obtenerUsuarioPorInstalacion(instalacionId: string): Promise<string | null> {
    return this.kv.get(`instalacion:${instalacionId}`, 'text');
  }

  async vincularInstalacion(instalacionId: string, userId: string): Promise<void> {
    await this.kv.put(`instalacion:${instalacionId}`, userId);
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

    // 'analizada' lo pone el agente de IA, que responde a los pocos segundos
    // de crearse la incidencia. Los eventos de GitHub no llegan ordenados: si
    // el mantenedor ya la habia movido a mano, aplicarlo tal cual la haria
    // retroceder y el usuario veria «nadie la ha mirado» despues de haber
    // hablado con una persona. Solo se protege de esto el estado automatico;
    // lo que decide una persona manda siempre, incluso hacia atras.
    const retrocedeElAgente =
      cambios.estado === 'analizada' &&
      RANGO_ESTADO[ticket.estado] > RANGO_ESTADO.analizada;

    // Un evento que no aporta nada no debe escribir. KV no tiene escrituras
    // condicionales y sus lecturas van con retraso, asi que este metodo lee,
    // modifica y guarda sobre una foto que puede ser vieja: si guarda igual,
    // machaca lo que se haya escrito entre medias. Pasa de verdad. Al
    // responder en una incidencia resuelta, la app escribe el mensaje y luego
    // GitHub avisa de la reapertura y de la etiqueta; ese webhook llegaba con
    // el ticket de antes y devolvia el hilo sin el mensaje recien enviado.
    // Cuando el estado que trae el evento ya esta puesto y no hay respuesta
    // nueva, no hay nada que guardar.
    const sinCambios =
      !cambios.respuesta &&
      (!cambios.estado || retrocedeElAgente || cambios.estado === ticket.estado);
    if (sinCambios) return ticket;

    if (cambios.estado && !retrocedeElAgente) {
      ticket.estado = cambios.estado;
      // La fecha de cierre se fija la primera vez y no se toca despues: si el
      // mantenedor reabre y vuelve a cerrar, interesa cuando quedo resuelta.
      if (cambios.estado === 'resuelta' && !ticket.cerrada_at) {
        ticket.cerrada_at = new Date().toISOString();
      }
      // Si el equipo la saca de `resuelta`, la confirmacion del usuario deja
      // de tener sentido: se referia a una solucion que ya no esta vigente.
      if (cambios.estado !== 'resuelta') {
        ticket.cerrada_at = null;
        ticket.confirmada_at = null;
      }
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

  /**
   * Anade una respuesta a un ticket identificado por su id (no por el numero
   * de issue). La usa el endpoint con el que el usuario contesta desde la app,
   * donde ya se sabe cual es el ticket y quien es su dueno, en lugar de
   * esperar a que el webhook devuelva el comentario: el webhook ignora los
   * mensajes del propio usuario para no duplicarlos.
   */
  async anadirRespuesta(
    ticketId: string,
    respuesta: RespuestaTicket | null,
    cambios: { estado?: EstadoTicket; confirmada?: boolean } = {},
  ): Promise<Ticket | null> {
    const ticket = await this.obtenerTicket(ticketId);
    if (!ticket) return null;
    if (respuesta) {
      const respuestas = ticket.respuestas ?? [];
      respuestas.push(respuesta);
      ticket.respuestas = respuestas.slice(-50);
    }
    // El estado y la respuesta se escriben juntos por lo mismo que en
    // `aplicarEventoDeIssue`: separarlos deja una ventana en la que el usuario
    // ve su mensaje con el estado viejo, o el estado nuevo sin el mensaje.
    if (cambios.estado) {
      ticket.estado = cambios.estado;
      if (cambios.estado !== 'resuelta') {
        ticket.cerrada_at = null;
        ticket.confirmada_at = null;
      }
    }
    if (cambios.confirmada) {
      ticket.confirmada_at = new Date().toISOString();
      if (!ticket.cerrada_at) ticket.cerrada_at = ticket.confirmada_at;
    }
    ticket.updated_at = new Date().toISOString();
    await this.kv.put('ticket:' + ticketId, JSON.stringify(ticket));
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

  /**
   * Contador por IP y hora para el acunado de claves de Microsoft Store, que es
   * anonimo por necesidad: WinRT necesita el ticket antes de que exista sesion,
   * asi que no hay user_id con el que limitar. Ventana horaria en vez de diaria
   * porque una IP compartida (oficina, NAT de operador) agrupa a mucha gente y
   * un cupo diario la dejaria fuera todo el dia.
   */
  async contarAcunadosDeLaHora(ip: string): Promise<number> {
    const hora = new Date().toISOString().slice(0, 13);
    const valor = await this.kv.get(`ratelimit:msticket:${ip}:${hora}`, 'text');
    return valor ? parseInt(valor, 10) || 0 : 0;
  }

  async incrementarAcunadosDeLaHora(ip: string): Promise<void> {
    const hora = new Date().toISOString().slice(0, 13);
    const clave = `ratelimit:msticket:${ip}:${hora}`;
    const actual = await this.contarAcunadosDeLaHora(ip);
    await this.kv.put(clave, String(actual + 1), { expirationTtl: 60 * 60 * 3 });
  }

  /**
   * Contador aparte para los mensajes que el usuario escribe en incidencias ya
   * abiertas. No comparte cupo con la creacion de tickets: agotar el limite
   * respondiendo a soporte no debe impedirte reportar un fallo nuevo.
   */
  async contarMensajesDelDia(userId: string): Promise<number> {
    const dia = new Date().toISOString().slice(0, 10);
    const valor = await this.kv.get('msgs:' + userId + ':' + dia, 'text');
    return valor ? parseInt(valor, 10) || 0 : 0;
  }

  async incrementarMensajesDelDia(userId: string): Promise<void> {
    const dia = new Date().toISOString().slice(0, 10);
    const actual = await this.contarMensajesDelDia(userId);
    await this.kv.put('msgs:' + userId + ':' + dia, String(actual + 1), {
      expirationTtl: 60 * 60 * 48,
    });
  }
}
