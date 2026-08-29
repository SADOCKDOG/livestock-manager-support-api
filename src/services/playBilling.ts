/**
 * Verificacion de la licencia de soporte contra Google Play.
 *
 * Nunca se confia en lo que diga el cliente sobre su compra: el cliente envia
 * el purchase_token y aqui se pregunta a Google si es real y sigue vigente.
 *
 * PENDIENTE DE DEFINIR (doc, seccion 11): compra unica vs suscripcion. Estan
 * implementadas las dos rutas; `verificarLicenciaAndroid` elige segun el
 * producto. Cambiar el modelo se reduce a cambiar PRODUCTO_SOPORTE y el flag.
 */

import { SignJWT, importPKCS8 } from 'jose';

/** Id del producto en Play Console. Debe coincidir exactamente. */
export const PRODUCTO_SOPORTE = 'support_unlock';

/**
 * Suscripcion, no compra unica: el soporte tiene coste recurrente (cada ticket
 * gasta IA), asi que el ingreso tambien debe serlo. Con compra unica un pago
 * de una vez daria derecho a soporte indefinido.
 */
export const SOPORTE_ES_SUSCRIPCION = true;

const AMBITO = 'https://www.googleapis.com/auth/androidpublisher';
const URL_TOKEN = 'https://oauth2.googleapis.com/token';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';

interface CuentaServicio {
  client_email: string;
  private_key: string;
}

/**
 * Mensaje de error de Google, recortado. No lleva secretos: es la explicacion
 * que devuelve la propia API, y sin ella el codigo HTTP a secas obliga a
 * adivinar cual de las varias causas posibles es.
 */
async function detalle(respuesta: Response): Promise<string> {
  const texto = await respuesta.text().catch(() => '');
  return texto ? texto.slice(0, 300) : 'sin cuerpo';
}

let tokenCacheado: { token: string; expira: number } | null = null;

/** Access token OAuth2 mediante JWT firmado con la cuenta de servicio. */
async function tokenDeAcceso(cuentaJSON: string): Promise<string> {
  if (tokenCacheado && tokenCacheado.expira > Date.now() + 60_000) {
    return tokenCacheado.token;
  }
  let cuenta: CuentaServicio;
  try {
    cuenta = JSON.parse(cuentaJSON) as CuentaServicio;
  } catch {
    throw new Error(
      'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON no es JSON valido: debe ser el fichero '
        + 'completo de la cuenta de servicio descargado de Google Cloud.',
    );
  }
  // Sin esta comprobacion el fallo sale como un TypeError opaco ("reading
  // includes") que no delata que el secreto este mal cargado. Paso el
  // 2026-08-28: el secreto existia, pero sin private_key dentro.
  if (!cuenta || !cuenta.private_key || !cuenta.client_email) {
    throw new Error(
      'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON incompleto: faltan private_key o '
        + 'client_email. Recargalo con: wrangler secret put '
        + 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON --env production',
    );
  }
  const clavePEM = cuenta.private_key.includes('\\n')
    ? cuenta.private_key.replace(/\\n/g, '\n')
    : cuenta.private_key;
  const clave = await importPKCS8(clavePEM, 'RS256');

  const ahora = Math.floor(Date.now() / 1000);
  const aserto = await new SignJWT({ scope: AMBITO })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(cuenta.client_email)
    .setAudience(URL_TOKEN)
    .setIssuedAt(ahora)
    .setExpirationTime(ahora + 3600)
    .sign(clave);

  const respuesta = await fetch(URL_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: aserto,
    }),
  });
  if (!respuesta.ok) {
    throw new Error(
      `Google rechazo la autenticacion (${respuesta.status}): ${await detalle(respuesta)}`,
    );
  }
  const datos = (await respuesta.json()) as { access_token: string; expires_in: number };
  tokenCacheado = {
    token: datos.access_token,
    expira: Date.now() + datos.expires_in * 1000,
  };
  return datos.access_token;
}

export interface ResultadoLicencia {
  activa: boolean;
  /** ISO 8601. null en compra unica: no caduca. */
  expira: string | null;
  motivo?: string;
  /** true si es suscripcion; false si es compra unica. */
  es_suscripcion: boolean;
  /**
   * Solo en suscripciones. true = Google cobrara de nuevo en `expira`; false =
   * el usuario la ha cancelado y `expira` es la fecha en que pierde el acceso.
   * Sin este dato la app tendria que ensenar la misma frase en los dos casos,
   * que son opuestos para quien la lee.
   */
  renovacion_automatica: boolean | null;
}

/**
 * @param paquete  applicationId de la app (com.livestockmanager.app.manual).
 */
export async function verificarLicenciaAndroid(
  cuentaJSON: string,
  paquete: string,
  purchaseToken: string,
): Promise<ResultadoLicencia> {
  const token = await tokenDeAcceso(cuentaJSON);

  const ruta = SOPORTE_ES_SUSCRIPCION
    ? `${API}/applications/${paquete}/purchases/subscriptions/${PRODUCTO_SOPORTE}/tokens/${purchaseToken}`
    : `${API}/applications/${paquete}/purchases/products/${PRODUCTO_SOPORTE}/tokens/${purchaseToken}`;

  const respuesta = await fetch(ruta, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (respuesta.status === 404) {
    return {
      activa: false,
      expira: null,
      motivo: 'La compra no existe',
      es_suscripcion: SOPORTE_ES_SUSCRIPCION,
      renovacion_automatica: null,
    };
  }
  if (!respuesta.ok) {
    // El codigo solo no basta para saber que hacer: un 401 aqui casi siempre es
    // que la cuenta de servicio no esta invitada en Play Console, y un 403 que
    // la Google Play Android Developer API no esta habilitada en el proyecto de
    // Cloud. Google lo explica en el cuerpo, asi que se propaga.
    throw new Error(
      `Google Play respondio ${respuesta.status}: ${await detalle(respuesta)}`,
    );
  }

  if (SOPORTE_ES_SUSCRIPCION) {
    const sub = (await respuesta.json()) as {
      expiryTimeMillis?: string;
      paymentState?: number;
      autoRenewing?: boolean;
    };
    const expiraMs = Number(sub.expiryTimeMillis ?? 0);
    const vigente = expiraMs > Date.now();
    return {
      activa: vigente,
      expira: expiraMs ? new Date(expiraMs).toISOString() : null,
      motivo: vigente ? undefined : 'La suscripcion ha caducado',
      es_suscripcion: true,
      // Google omite el campo en algunos estados; se toma como cancelada solo
      // si viene explicitamente en false, no si falta.
      renovacion_automatica: sub.autoRenewing === undefined ? null : sub.autoRenewing,
    };
  }

  // Compra unica: purchaseState 0 = comprada. Se comprueba que no este anulada.
  const compra = (await respuesta.json()) as {
    purchaseState?: number;
    consumptionState?: number;
  };
  const comprada = compra.purchaseState === 0;
  return {
    activa: comprada,
    expira: null,
    motivo: comprada ? undefined : 'La compra fue cancelada o reembolsada',
    es_suscripcion: false,
    renovacion_automatica: null,
  };
}
