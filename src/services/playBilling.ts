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

let tokenCacheado: { token: string; expira: number } | null = null;

/** Access token OAuth2 mediante JWT firmado con la cuenta de servicio. */
async function tokenDeAcceso(cuentaJSON: string): Promise<string> {
  if (tokenCacheado && tokenCacheado.expira > Date.now() + 60_000) {
    return tokenCacheado.token;
  }
  const cuenta = JSON.parse(cuentaJSON) as CuentaServicio;
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
    throw new Error(`Google rechazo la autenticacion (${respuesta.status})`);
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
    return { activa: false, expira: null, motivo: 'La compra no existe' };
  }
  if (!respuesta.ok) {
    throw new Error(`Google Play respondio ${respuesta.status}`);
  }

  if (SOPORTE_ES_SUSCRIPCION) {
    const sub = (await respuesta.json()) as {
      expiryTimeMillis?: string;
      paymentState?: number;
    };
    const expiraMs = Number(sub.expiryTimeMillis ?? 0);
    const vigente = expiraMs > Date.now();
    return {
      activa: vigente,
      expira: expiraMs ? new Date(expiraMs).toISOString() : null,
      motivo: vigente ? undefined : 'La suscripcion ha caducado',
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
  };
}
