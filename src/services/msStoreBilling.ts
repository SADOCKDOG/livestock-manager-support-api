/**
 * Verificacion de la licencia de soporte contra Microsoft Store.
 *
 * Nunca se confia en lo que diga el cliente. Ojo: en Microsoft Store el
 * purchaseToken que devuelve la Digital Goods API es el id del complemento
 * ('support_unlock'), identico para todo el mundo, asi que no prueba nada. La
 * prueba real es la Store ID key, que el cliente acuna con WinRT y que aqui se
 * cambia por la coleccion de compras del comprador.
 */

import type { ResultadoLicencia } from './playBilling';

/** InAppOfferToken del complemento en Partner Center. Debe coincidir. */
export const PRODUCTO_SOPORTE_MS = 'support_unlock';

const URL_COLECCIONES = 'https://collections.mp.microsoft.com/v6.0/collections/query';
/**
 * `localTicketReference` es obligatorio y vuelve reflejado en cada elemento.
 * No se usa para nada aqui: se manda un valor fijo y no vacio para cumplir el
 * contrato sin filtrar informacion del usuario.
 */
const REFERENCIA = 'soporte';
/** Tope de paginas de la coleccion: freno contra un bucle, no un limite esperado. */
const MAX_PAGINAS = 20;
/**
 * Hay TRES audiencias distintas y no son intercambiables (lo documenta
 * Microsoft y lo confirma su libreria Microsoft.StoreServices):
 *  - SERVICIO: el bearer con el que este Worker llama a las API de Microsoft.
 *    No debe salir de aqui nunca: expuesto al cliente permite ataques de
 *    repeticion contra la API.
 *  - CLAVE_COLECCIONES y CLAVE_COMPRAS: los tickets que SI se mandan a la app,
 *    porque WinRT los necesita para acunar la Store ID key. Solo sirven para
 *    acunar claves, y cada uno produce una clave que vale para su servicio y no
 *    para el otro: la de compras rechaza las de colecciones con IDX10205.
 */
export const AUDIENCIA_SERVICIO = 'https://onestore.microsoft.com';
export const AUDIENCIA_CLAVE_COLECCIONES =
  'https://onestore.microsoft.com/b2b/keys/create/collections';
export const AUDIENCIA_CLAVE_COMPRAS =
  'https://onestore.microsoft.com/b2b/keys/create/purchase';

/** Un elemento de la coleccion (CollectionItemContractV6), recortado a lo usado. */
export interface ElementoColeccion {
  inAppOfferToken?: string;
  productId?: string;
  orderId?: string;
  transactionId?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  acquiredDate?: string;
  purchaser?: { identityType?: string; identityValue?: string };
}

export interface LicenciaWindows extends ResultadoLicencia {
  /** Ancla de identidad en Windows. null si no hay compra que anclar. */
  order_id: string | null;
  /**
   * `publisherUserId` que el cliente declaro al acunar la Store ID key, tal y
   * como lo devuelve Microsoft. Lo usamos como id de instalacion: permite
   * comprobar que la clave corresponde a la instalacion que dice ser.
   */
  instalacion_declarada: string | null;
}

function vacia(motivo: string): LicenciaWindows {
  return {
    activa: false,
    expira: null,
    motivo,
    es_suscripcion: true,
    renovacion_automatica: null,
    // Microsoft no expone nada equivalente a linkedPurchaseToken.
    token_anterior: null,
    order_id: null,
    instalacion_declarada: null,
  };
}

/**
 * Decide si hay licencia a partir de la coleccion. Puro: sin red ni reloj
 * implicito, para poder probarlo contra respuestas grabadas.
 */
/**
 * ?Sigue viva la licencia del usuario que ya tenia esta instalacion?
 *
 * En Android esto se le pregunta a Google con el token viejo. En Windows no se
 * puede: la coleccion se consulta por comprador, y la que se acaba de leer es
 * la de QUIEN LLAMA, no la del anterior. Sin una respuesta, el freno
 * `dos-licencias-vivas` no existiria aqui, y eso importa porque la instalacion
 * que declara el cliente al acunar la clave se la inventa el: Microsoft la
 * devuelve firmada, pero no la valida. Quien declarase la instalacion de otro
 * se llevaria su historial de incidencias.
 *
 * Asi que se responde con lo ultimo que sabemos de esa persona, que es lo que
 * quedo guardado la ultima vez que abrio la app. Queda un hueco: si renovo y no
 * ha vuelto a abrirla desde entonces, su licencia consta caducada y se puede
 * adoptar. Es mucho menos malo que la alternativa, que era no frenar nunca.
 */
export function licenciaVivaSegunAlmacen(
  usuario: { licencia_soporte_activa?: boolean; licencia_expira?: string | null } | null,
  ahora: number = Date.now(),
): { activa: boolean } {
  if (!usuario || !usuario.licencia_soporte_activa) return { activa: false };
  // Sin fecha se considera viva: ante la duda, no se adopta la identidad.
  if (!usuario.licencia_expira) return { activa: true };
  const expira = Date.parse(usuario.licencia_expira);
  if (Number.isNaN(expira)) return { activa: true };
  return { activa: expira > ahora };
}

/**
 * Estados que acreditan que la compra sigue en pie.
 *
 * `Active` es el unico que «Query for products» da por vigente. Se acepta ademas
 * `PUR-UserAlreadyOwnsContent`, que no es un estado de la coleccion sino el
 * mensaje que la Store muestra al comprador que ya posee el complemento: es
 * tolerancia por si asoma en la respuesta, no una via alternativa de licencia.
 * Aceptarlo no relaja el resto de comprobaciones: sin endDate futura se deniega.
 */
function acreditaCompra(status: string | undefined): boolean {
  return status === 'Active' || status === 'PUR-UserAlreadyOwnsContent';
}

export function interpretarColeccion(
  items: ElementoColeccion[],
  ahoraMs: number = Date.now(),
): LicenciaWindows {
  const nuestros = (items ?? []).filter((i) => i && i.inAppOfferToken === PRODUCTO_SOPORTE_MS);
  if (nuestros.length === 0) {
    return vacia('No hay ninguna compra del soporte');
  }

  // La que caduca mas tarde es la que manda: al renovar conviven brevemente la
  // vieja y la nueva, y quedarse con la primera daria por caducado a alguien
  // que acaba de pagar.
  const ordenados = [...nuestros].sort(
    (a, b) => (Date.parse(b.endDate ?? '') || 0) - (Date.parse(a.endDate ?? '') || 0),
  );
  // Un elemento revocado puede caducar DESPUES que la compra buena: quien pidio
  // el reembolso de una anual y luego contrato una mensual tiene el revocado por
  // delante. Ordenar solo por fecha le denegaria la licencia a quien acaba de
  // pagar, asi que lo activo se examina primero; el resto solo sirve para
  // explicar el motivo y conservar el ancla de identidad.
  const item = ordenados.find((i) => acreditaCompra(i.status)) ?? ordenados[0];
  // Inalcanzable: nuestros.length > 0 garantiza ordenados[0], pero
  // noUncheckedIndexedAccess no lo sabe. Se mantiene la guarda por
  // coherencia con "sin verificacion no hay licencia".
  if (!item) {
    return vacia('No hay ninguna compra del soporte');
  }

  const finMs = item.endDate ? Date.parse(item.endDate) : NaN;
  const base: LicenciaWindows = {
    activa: false,
    expira: Number.isFinite(finMs) ? new Date(finMs).toISOString() : null,
    es_suscripcion: true,
    renovacion_automatica: null,
    token_anterior: null,
    order_id: item.orderId ?? null,
    instalacion_declarada: item.purchaser?.identityValue ?? null,
  };

  if (item.status === 'Revoked' || item.status === 'Banned') {
    // Equivale a un reembolso en Google: hubo compra, pero ya no vale.
    return { ...base, motivo: 'La compra fue revocada o reembolsada' };
  }
  if (!acreditaCompra(item.status)) {
    // Incluye 'Expired' y cualquier estado que Microsoft anada despues sin
    // acreditar la compra. No se presume nada: sin verificacion positiva no hay
    // licencia.
    return { ...base, motivo: 'La suscripcion no esta activa' };
  }
  if (!Number.isFinite(finMs)) {
    return { ...base, motivo: 'La suscripcion no tiene fecha de caducidad' };
  }
  if (finMs <= ahoraMs) {
    return { ...base, motivo: 'La suscripcion ha caducado' };
  }

  return { ...base, activa: true };
}

interface RespuestaColecciones {
  items?: ElementoColeccion[];
  /** Lo manda Microsoft cuando quedan mas paginas por leer. */
  continuationToken?: string;
}

/**
 * Tokens vivos, uno por audiencia: las dos se piden en el mismo arranque y
 * comparten cliente, asi que una sola casilla se pisaria a si misma. Mismo
 * patron que playBilling.ts, con el que Android ya evita agotar la cuota.
 */
const tokensCacheados = new Map<string, { token: string; expira: number }>();

/** Access token de Entra ID para la API de colecciones (client credentials). */
export async function tokenDeAcceso(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  audiencia: string = AUDIENCIA_SERVICIO,
): Promise<string> {
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      'Faltan MS_ENTRA_TENANT_ID, MS_ENTRA_CLIENT_ID o MS_ENTRA_CLIENT_SECRET: '
        + 'cargalos con wrangler secret put --env production',
    );
  }
  // Margen de un minuto: un token a punto de caducar puede vencer entre esta
  // comprobacion y la llamada a Microsoft.
  const vivo = tokensCacheados.get(audiencia);
  if (vivo && vivo.expira > Date.now() + 60_000) {
    return vivo.token;
  }

  const respuesta = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: `${audiencia}/.default`,
      }),
    },
  );
  if (!respuesta.ok) {
    const texto = (await respuesta.text().catch(() => '')).slice(0, 300);
    throw new Error(`Entra ID rechazo la autenticacion (${respuesta.status}): ${texto}`);
  }
  const datos = (await respuesta.json()) as { access_token?: string; expires_in?: number };
  if (!datos.access_token) throw new Error('Entra ID no devolvio access_token');
  // Sin expires_in no se cachea: mas vale volver a pedirlo que servir un token
  // caducado con una vigencia inventada.
  if (datos.expires_in) {
    tokensCacheados.set(audiencia, {
      token: datos.access_token,
      expira: Date.now() + datos.expires_in * 1000,
    });
  }
  return datos.access_token;
}

/**
 * Store ID del complemento de soporte en Partner Center. La API de compras
 * devuelve este identificador (no el InAppOfferToken) en `productId`, y es lo
 * que permite comprobar que la suscripcion leida es la nuestra y no otra.
 */
const STORE_ID_SOPORTE_MS = '9P4577W3B0D2';

/** El unico estado de suscripcion que acredita el derecho al servicio. */
const RECURRENCE_ACTIVA = 'Active';

/** Endpoint de la API de compras para las suscripciones de un comprador. */
const URL_SUSCRIPCIONES = 'https://purchase.mp.microsoft.com/v8.0/b2b/recurrences/query';

/** Una suscripcion tal y como la devuelve recurrences/query. */
interface SuscripcionB2B {
  id?: string;
  productId?: string;
  skuId?: string;
  autoRenew?: boolean;
  recurrenceState?: string;
  expirationTime?: string;
  isTrial?: boolean;
}

/** Descifra un tramo base64url, que es como viaja el payload de un JWT. */
function base64UrlATexto(tramo: string): string {
  const b64 = tramo.replace(/-/g, '+').replace(/_/g, '/');
  const relleno = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return atob(b64 + relleno);
}

/**
 * Emisor y usuario declarado de una Store ID key.
 *
 * La clave es un JWT que firma Microsoft y cuyos claims viajan en claro (solo
 * el payload interno va cifrado), asi que se pueden leer sin verificar nada. No
 * se usa para autorizar —para eso esta la consulta a Microsoft— sino para dos
 * cosas: elegir por que servicio hay que preguntar, y recuperar el
 * `publisherUserId` que la app declaro, que en la via de suscripciones no viene
 * en la respuesta.
 */
function emisorYUsuarioDeClave(clave: string): { emisor: string; usuario: string } {
  const partes = clave.split('.');
  const tramo = partes[1];
  if (!tramo) return { emisor: '', usuario: '' };
  try {
    const payload = JSON.parse(base64UrlATexto(tramo)) as Record<string, unknown>;
    const usuario = payload['http://schemas.microsoft.com/marketplace/2015/08/claims/key/userId'];
    return {
      emisor: typeof payload.iss === 'string' ? payload.iss : '',
      usuario: typeof usuario === 'string' ? usuario : '',
    };
  } catch {
    return { emisor: '', usuario: '' };
  }
}

/**
 * Decide si hay licencia a partir de las suscripciones del comprador.
 * Puro: sin red ni reloj implicito, para poder probarlo contra respuestas
 * grabadas.
 */
export function interpretarSuscripcion(
  items: SuscripcionB2B[],
  instalacionDeclarada: string | null,
  ahoraMs: number = Date.now(),
): LicenciaWindows {
  const nuestras = (items ?? []).filter((s) => s && s.productId === STORE_ID_SOPORTE_MS);
  if (nuestras.length === 0) {
    return vacia('No hay ninguna suscripcion del soporte');
  }

  // La que caduca mas tarde manda: al renovar o recomprar conviven brevemente
  // la vieja y la nueva, y quedarse con la primera denegaria la licencia a
  // quien acaba de pagar.
  const activas = nuestras
    .filter((s) => s.recurrenceState === RECURRENCE_ACTIVA)
    .sort(
      (a, b) =>
        (Date.parse(b.expirationTime ?? '') || 0) - (Date.parse(a.expirationTime ?? '') || 0),
    );
  const item = activas[0];

  const base: LicenciaWindows = {
    activa: false,
    expira: null,
    es_suscripcion: true,
    renovacion_automatica: null,
    token_anterior: null,
    // El id de la suscripcion es el ancla de identidad: lo firma Microsoft y no
    // cambia en toda la vida de la suscripcion (una recompra crea uno nuevo).
    order_id: item?.id ?? null,
    instalacion_declarada: instalacionDeclarada || null,
  };

  if (!item) {
    return { ...base, motivo: 'La suscripcion del soporte no esta activa' };
  }
  const finMs = item.expirationTime ? Date.parse(item.expirationTime) : NaN;
  if (!Number.isFinite(finMs)) {
    return { ...base, motivo: 'La suscripcion no tiene fecha de caducidad' };
  }
  if (finMs <= ahoraMs) {
    return { ...base, motivo: 'La suscripcion ha caducado' };
  }
  return {
    ...base,
    activa: true,
    expira: new Date(finMs).toISOString(),
    renovacion_automatica: item.autoRenew ?? null,
  };
}

/**
 * Consulta las suscripciones del comprador en la API de compras, que es donde
 * Microsoft publica este tipo de complemento. Lanza si Microsoft no responde,
 * igual que la via de la coleccion.
 */
async function verificarPorSuscripcion(
  token: string,
  storeIdKey: string,
  instalacionDeclarada: string | null,
): Promise<LicenciaWindows> {
  const acumuladas: SuscripcionB2B[] = [];
  let continuacion: string | undefined;
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina += 1) {
    const respuesta = await fetch(URL_SUSCRIPCIONES, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        b2bKey: storeIdKey,
        ...(continuacion ? { continuationToken: continuacion } : {}),
      }),
    });
    if (!respuesta.ok) {
      const texto = (await respuesta.text().catch(() => '')).slice(0, 300);
      throw new Error(`La API de compras respondio ${respuesta.status}: ${texto}`);
    }
    const datos = (await respuesta.json()) as {
      items?: SuscripcionB2B[];
      continuationToken?: string;
    };
    acumuladas.push(...(datos.items ?? []));
    if (!datos.continuationToken) {
      return interpretarSuscripcion(acumuladas, instalacionDeclarada);
    }
    continuacion = datos.continuationToken;
  }
  throw new Error(`La API de compras no dejo de paginar tras ${MAX_PAGINAS} paginas`);
}

/**
 * Verifica la licencia de soporte contra Microsoft Store.
 *
 * Hay dos puertas porque Microsoft firma la Store ID key para UN servicio y no
 * vale para el otro: el de compras valida el emisor y rechaza las de colecciones
 * con IDX10205. Se elige por el emisor de la clave que llega, y asi la misma
 * version del Worker atiende a las dos generaciones de la app.
 *
 * Lanza si Microsoft no responde: quien llama debe tratarlo como «no se sabe»,
 * nunca como «no tiene licencia».
 */
export async function verificarLicenciaWindows(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  storeIdKey: string,
): Promise<LicenciaWindows> {
  const token = await tokenDeAcceso(tenantId, clientId, clientSecret);
  const { emisor, usuario } = emisorYUsuarioDeClave(storeIdKey);
  const licencia = emisor.includes('purchase.mp.microsoft.com')
    ? await verificarPorSuscripcion(token, storeIdKey, usuario || null)
    : await verificarPorColeccion(token, storeIdKey);
  console.log('[ms] licencia:', licencia.activa ? 'concede' : licencia.motivo);
  return licencia;
}

/**
 * Via de la coleccion: los complementos que no son suscripcion.
 * Lanza si Microsoft no responde: quien llama debe tratarlo como «no se sabe»,
 * nunca como «no tiene licencia».
 */
async function verificarPorColeccion(
  token: string,
  storeIdKey: string,
): Promise<LicenciaWindows> {
  const acumulados: ElementoColeccion[] = [];
  let continuacion: string | undefined;
  // La respuesta viene paginada. La primera pagina bastaria casi siempre, pero
  // al pedir validityType 'All' entran tambien los periodos ya caducados: una
  // suscripcion mensual acumula un elemento por renovacion y acaba desbordando
  // la pagina. Sin recorrerlas todas, un comprador antiguo perderia la licencia
  // y, con ella, el ancla de identidad.
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina += 1) {
    const respuesta = await fetch(URL_COLECCIONES, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        maxPageSize: 100,
        ...(continuacion ? { continuationToken: continuacion } : {}),
        beneficiaries: [
          { identityType: 'b2b', identityValue: storeIdKey, localTicketReference: REFERENCIA },
        ],
        // Obligatorio: sin el la API responde 400. 'Durable' es lo que devuelve
        // un complemento de suscripcion; 'UnmanagedConsumable' se incluye por si
        // el add-on cambiara de tipo. No se pide 'Application' porque solo
        // traeria la propia app, que aqui no interesa.
        productTypes: ['Durable', 'UnmanagedConsumable'],
        // Imprescindible: por defecto la API solo devuelve lo vigente. Sin esto
        // una licencia caducada seria indistinguible de no haber comprado nunca,
        // y se perderia el ancla de identidad que reencuentra el historial.
        validityType: 'All',
      }),
    });
    if (!respuesta.ok) {
      const texto = (await respuesta.text().catch(() => '')).slice(0, 300);
      throw new Error(`La API de colecciones respondio ${respuesta.status}: ${texto}`);
    }
    const datos = (await respuesta.json()) as RespuestaColecciones;
    acumulados.push(...(datos.items ?? []));
    if (!datos.continuationToken) {
      return interpretarColeccion(acumulados);
    }
    continuacion = datos.continuationToken;
  }
  // Microsoft sigue ofreciendo paginas pasado el tope. Se para y se lanza: con
  // una lectura incompleta no se puede afirmar que no hay licencia.
  throw new Error(`La API de colecciones no dejo de paginar tras ${MAX_PAGINAS} paginas`);
}
