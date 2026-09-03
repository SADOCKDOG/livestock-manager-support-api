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
 * Hay DOS audiencias distintas y no son intercambiables (lo documenta
 * Microsoft y lo confirma su libreria Microsoft.StoreServices):
 *  - SERVICIO: el bearer con el que este Worker llama a la API de colecciones.
 *    No debe salir de aqui nunca: expuesto al cliente permite ataques de
 *    repeticion contra la API.
 *  - CLAVE_COLECCIONES: el ticket que SI se manda a la app, porque WinRT lo
 *    necesita para acunar la Store ID key. Solo sirve para acunar claves.
 */
export const AUDIENCIA_SERVICIO = 'https://onestore.microsoft.com';
export const AUDIENCIA_CLAVE_COLECCIONES =
  'https://onestore.microsoft.com/b2b/keys/create/collections';

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
  const item = ordenados.find((i) => i.status === 'Active') ?? ordenados[0];
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
  if (item.status !== 'Active') {
    // Incluye 'Expired' y cualquier estado que Microsoft anada despues. No se
    // presume nada: sin verificacion positiva no hay licencia.
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
 * Consulta la coleccion del comprador identificado por la Store ID key.
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
