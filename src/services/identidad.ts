/**
 * A quien pertenece esta compra.
 *
 * La identidad se ancla al purchase_token, que Google renueva al recomprar o
 * cambiar de plan. El id de instalacion (generado en el movil, guardado en
 * IndexedDB y por tanto incluido en la copia de seguridad) es el puente entre
 * el token viejo y el nuevo.
 *
 * La decision vive aqui, separada de la ruta y del KV, porque tiene una regla
 * que no se puede equivocar: cuando NO se adopta la identidad anterior hay que
 * dejar el enlace `instalacion:<id>` como estaba. Reescribirlo apuntando al
 * usuario nuevo y vacio borra el unico camino de vuelta al historial, y
 * entonces ni restaurar la copia de seguridad lo recupera: el id restaurado
 * lleva al usuario vacio otra vez. Paso en produccion el 2026-09-03.
 */

import type { Usuario } from '../types';

/** Lo unico que hace falta del almacen; asi esto se puede probar sin KV. */
export interface LecturaIdentidad {
  obtenerUsuario(userId: string): Promise<Usuario | null>;
  obtenerUsuarioPorInstalacion(instalacionId: string): Promise<string | null>;
}

/** Consulta a Google si una licencia sigue viva. Puede lanzar. */
export type ComprobarLicencia = (purchaseToken: string) => Promise<{ activa: boolean }>;

export interface Resolucion {
  /** Identidad con la que se sigue: la adoptada o la del token nuevo. */
  userId: string;
  /** Usuario ya almacenado con ese id, si lo hay. */
  existente: Usuario | null;
  /** Si se debe escribir `instalacion:<id> -> userId`. */
  vincularInstalacion: boolean;
  /** Por que se decidio asi. Va al log; no lleva tokens ni correos. */
  motivo: string;
}

export interface OpcionesIdentidad {
  lectura: LecturaIdentidad;
  /** Hash del purchase_token recien verificado. */
  userIdDelToken: string;
  purchaseToken: string;
  /** Id de instalacion que manda la app, o '' si no lo manda. */
  instalacion: string;
  /**
   * `linkedPurchaseToken` de la compra nueva: Google lo rellena cuando esta
   * suscripcion sustituye a otra del mismo comprador. Es la unica prueba
   * server-side de que dos tokens distintos son la misma persona.
   */
  tokenEncadenado?: string | null;
  comprobarLicencia: ComprobarLicencia;
}

export async function resolverIdentidad(opciones: OpcionesIdentidad): Promise<Resolucion> {
  const { lectura, userIdDelToken, purchaseToken, instalacion, comprobarLicencia } = opciones;
  const existente = await lectura.obtenerUsuario(userIdDelToken);

  if (!instalacion) {
    return { userId: userIdDelToken, existente, vincularInstalacion: false, motivo: 'sin-instalacion' };
  }

  const enlazado = await lectura.obtenerUsuarioPorInstalacion(instalacion);

  if (existente) {
    // Ya se le conoce por el token. Solo se toma el enlace si esta libre o ya
    // es suyo: si apunta a otro, ese otro lo necesita para volver a su historial.
    const propio = !enlazado || enlazado === userIdDelToken;
    return {
      userId: userIdDelToken,
      existente,
      vincularInstalacion: propio,
      motivo: propio ? 'usuario-conocido' : 'enlace-de-otro-intacto',
    };
  }

  if (!enlazado) {
    return { userId: userIdDelToken, existente: null, vincularInstalacion: true, motivo: 'instalacion-nueva' };
  }

  if (enlazado === userIdDelToken) {
    // El enlace ya apunta aqui pero el usuario no esta: se creara ahora.
    return { userId: userIdDelToken, existente: null, vincularInstalacion: false, motivo: 'enlace-ya-correcto' };
  }

  const anterior = await lectura.obtenerUsuario(enlazado);
  if (!anterior) {
    return { userId: userIdDelToken, existente: null, vincularInstalacion: true, motivo: 'anterior-desaparecido' };
  }

  const tokenViejo = anterior.purchase_token;
  if (!tokenViejo || tokenViejo === purchaseToken) {
    return { userId: enlazado, existente: anterior, vincularInstalacion: false, motivo: 'misma-compra' };
  }

  // Google encadena la compra nueva con la que sustituye. Con eso basta: es el
  // mismo comprador aunque la licencia vieja siga contando como viva, que es lo
  // normal al recomprar antes de que caduque.
  if (opciones.tokenEncadenado && opciones.tokenEncadenado === tokenViejo) {
    return { userId: enlazado, existente: anterior, vincularInstalacion: false, motivo: 'recompra-encadenada' };
  }

  let vieja: { activa: boolean };
  try {
    vieja = await comprobarLicencia(tokenViejo);
  } catch {
    // No se sabe. Se sigue como usuario nuevo, pero el enlace se queda: el
    // proximo arranque puede volver a intentarlo y recuperar el historial.
    return { userId: userIdDelToken, existente: null, vincularInstalacion: false, motivo: 'comprobacion-fallida' };
  }

  if (vieja.activa) {
    // Dos licencias vivas sin encadenar entre si: lo mas probable es que sean
    // dos personas, y una haya restaurado la copia de la otra. Antes que
    // ensenar un historial ajeno, historial vacio.
    return { userId: userIdDelToken, existente: null, vincularInstalacion: false, motivo: 'dos-licencias-vivas' };
  }

  return { userId: enlazado, existente: anterior, vincularInstalacion: false, motivo: 'licencia-anterior-caducada' };
}
