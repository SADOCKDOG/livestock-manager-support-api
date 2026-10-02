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

export const AUDIENCIA_SERVICIO = 'https://onestore.microsoft.com';
export const AUDIENCIA_CLAVE_COLECCIONES =
  'https://onestore.microsoft.com/b2b/keys/create/collections';
export const AUDIENCIA_CLAVE_COMPRAS =
  'https://onestore.microsoft.com/b2b/keys/create/purchase';

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
  order_id: string | null;
  instalacion_declarada: string | null;
}

function vacia(motivo: string): LicenciaWindows {
  return {
    activa: false,
    expira: null,
    motivo,
    es_suscripcion: true,
    renovacion_automatica: null,
    token_anterior: null,
    order_id: null,
    instalacion_declarada: null,
  };
}

export function licenciaVivaSegunAlmacen(
  usuario: { licencia_soporte_activa?: boolean; licencia_expira?: string | null } | null,
  ahora: number = Date.now(),
): { activa: boolean } {
  if (!usuario || !usuario.licencia_soporte_activa) return { activa: false };
  if (!usuario.licencia_expira) return { activa: true };
  const expira = Date.parse(usuario.licencia_expira);
  if (Number.isNaN(expira)) return { activa: true };
  return { activa: expira > ahora };
}

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

  const ordenados = [...nuestros].sort(
    (a, b) => (Date.parse(b.endDate ?? '') || 0) - (Date.parse(a.endDate ?? '') || 0),
  );
  const item = ordenados.find((i) => acreditaCompra(i.status)) ?? ordenados[0];
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
    return { ...base, motivo: 'La compra fue revocada o reembolsada' };
  }
  if (!acreditaCompra(item.status)) {
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
  continuationToken?: string;
}

const tokensCacheados = new Map<string, { token: string; expira: number }>();

export async function tokenDeAcceso(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  audiencia: string = AUDIENCIA_SERVICIO,
): Promise<string> {
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      'Faltan MS_ENTRA_TENANT_ID, MS_ENTRA_CLIENT_ID o MS_ENTRA_CLIENT_SECRET: ' +
        'cargalos con wrangler secret put --env production',
    );
  }
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
  if (datos.expires_in) {
    tokensCacheados.set(audiencia, {
      token: datos.access_token,
      expira: Date.now() + datos.expires_in * 1000,
    });
  }
  return datos.access_token;
}

const STORE_ID_SOPORTE_MS = '9P4577W3B0D2';
const RECURRENCE_ACTIVA = 'Active';
const URL_SUSCRIPCIONES = 'https://purchase.mp.microsoft.com/v8.0/b2b/recurrences/query';

interface SuscripcionB2B {
  id?: string;
  productId?: string;
  skuId?: string;
  autoRenew?: boolean;
  recurrenceState?: string;
  expirationTime?: string;
  isTrial?: boolean;
}

function base64UrlATexto(tramo: string): string {
  const b64 = tramo.replace(/-/g, '+').replace(/_/g, '/');
  const relleno = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return atob(b64 + relleno);
}

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

export function interpretarSuscripcion(
  items: SuscripcionB2B[],
  instalacionDeclarada: string | null,
  ahoraMs: number = Date.now(),
): LicenciaWindows {
  const nuestras = (items ?? []).filter((s) => s && s.productId === STORE_ID_SOPORTE_MS);
  if (nuestras.length === 0) {
    return vacia('No hay ninguna suscripcion del soporte');
  }

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

export async function verificarLicenciaWindows(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  storeIdKey: string,
): Promise<LicenciaWindows> {
  const token = await tokenDeAcceso(tenantId, clientId, clientSecret);
  const { emisor, usuario } = emisorYUsuarioDeClave(storeIdKey);
  const esSuscripcionMicrosoft = /^https:\/\/purchase\.mp\.microsoft\.com(?=\/|$)/i.test(emisor);
  const licencia = esSuscripcionMicrosoft
    ? await verificarPorSuscripcion(token, storeIdKey, usuario || null)
    : await verificarPorColeccion(token, storeIdKey);
  console.log('[ms] licencia:', licencia.activa ? 'concede' : licencia.motivo);
  return licencia;
}

async function verificarPorColeccion(
  token: string,
  storeIdKey: string,
): Promise<LicenciaWindows> {
  const acumulados: ElementoColeccion[] = [];
  let continuacion: string | undefined;
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
        productTypes: ['Durable', 'UnmanagedConsumable'],
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
  throw new Error(`La API de colecciones no dejo de paginar tras ${MAX_PAGINAS} paginas`);
}
