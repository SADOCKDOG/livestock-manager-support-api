/**
 * Creacion de issues via GitHub App.
 *
 * PRINCIPIO NO NEGOCIABLE: este servicio solo sabe crear y comentar issues.
 * No expone ninguna funcion para crear ramas, commits ni pull requests, y la
 * GitHub App debe estar instalada con permiso `Issues: write` unicamente. Si
 * alguna vez hiciera falta mas, la decision se toma fuera de aqui.
 *
 * Se usa jose + fetch en vez de @octokit: en Workers pesa mucho menos y evita
 * las dependencias de Node que octokit arrastra.
 */

import { SignJWT, importPKCS8 } from 'jose';
import type { Env, Severidad } from '../types';

const API = 'https://api.github.com';
const UA = 'livestock-manager-support-api';

/** Cache del installation token en memoria del isolate (expira a la hora). */
let tokenCacheado: { token: string; expira: number } | null = null;

/** Longitud en formato DER: corta si cabe en un byte, larga si no. */
function longitudDER(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

/**
 * Envuelve un RSAPrivateKey (PKCS#1) en un PrivateKeyInfo (PKCS#8).
 *
 * Es puro empaquetado ASN.1: la clave no se toca, solo se le antepone la
 * cabecera que declara «esto es RSA». Los 15 bytes fijos son el
 * AlgorithmIdentifier de rsaEncryption (OID 1.2.840.113549.1.1.1 + NULL).
 */
function pkcs1APkcs8(der: Uint8Array): Uint8Array {
  const algoritmo = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
    0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ];
  const octetString = [0x04, ...longitudDER(der.length)];
  const version = [0x02, 0x01, 0x00];
  const cuerpo = version.length + algoritmo.length + octetString.length + der.length;
  const cabecera = [0x30, ...longitudDER(cuerpo), ...version, ...algoritmo, ...octetString];

  const salida = new Uint8Array(cabecera.length + der.length);
  salida.set(cabecera, 0);
  salida.set(der, cabecera.length);
  return salida;
}

/** DER -> PEM en lineas de 64 columnas, que es lo que espera cualquier parser. */
function aPEM(der: Uint8Array, etiqueta: string): string {
  let binario = '';
  for (const b of der) binario += String.fromCharCode(b);
  const b64 = (btoa(binario).match(/.{1,64}/g) ?? []).join('\n');
  return '-----BEGIN ' + etiqueta + '-----\n' + b64 + '\n-----END ' + etiqueta + '-----\n';
}

/**
 * Deja la clave privada de la App en PKCS#8, el unico formato que acepta
 * `importPKCS8`.
 *
 * GitHub entrega las claves de las Apps en PKCS#1 («BEGIN RSA PRIVATE KEY»).
 * Pasarsela tal cual a jose lanzaba un TypeError seco que el catch de
 * `/tickets/confirm` convertia en un 502 generico: el usuario veia «no se pudo
 * registrar la incidencia» y en el log solo quedaba un stack sin mensaje. Por
 * esto no se llego a crear ni un solo issue.
 *
 * Tambien se deshacen los saltos de linea escapados, que es como queda el
 * secreto si se pega en la consola de Cloudflare en vez de darlo por stdin.
 */
function normalizarClave(clave: string): string {
  const limpia = (clave.includes('\n') ? clave.replace(/\n/g, '\n') : clave).trim();

  if (limpia.startsWith('-----BEGIN PRIVATE KEY-----')) return limpia;

  if (limpia.startsWith('-----BEGIN RSA PRIVATE KEY-----')) {
    const b64 = limpia.replace(/-----(BEGIN|END) RSA PRIVATE KEY-----/g, '').replace(/\s/g, '');
    const binario = atob(b64);
    const der = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i++) der[i] = binario.charCodeAt(i);
    return aPEM(pkcs1APkcs8(der), 'PRIVATE KEY');
  }

  // Ni PKCS#8 ni PKCS#1. Se dice que cabecera trae, nunca el contenido.
  const corte = limpia.indexOf('\n');
  throw new Error(
    'GITHUB_APP_PRIVATE_KEY no parece una clave PEM. Empieza por: ' +
      JSON.stringify(limpia.slice(0, corte === -1 ? 40 : corte))
  );
}

/** JWT firmado con la clave privada de la App (valido 10 min como maximo). */
async function jwtDeApp(env: Env): Promise<string> {
  const clave = await importPKCS8(normalizarClave(env.GITHUB_APP_PRIVATE_KEY), 'RS256');
  const ahora = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(ahora - 60) // margen por desfase de reloj
    .setExpirationTime(ahora + 9 * 60)
    .setIssuer(env.GITHUB_APP_ID)
    .sign(clave);
}

/** Token de instalacion, de corta duracion. Se cachea hasta 5 min antes de caducar. */
async function tokenDeInstalacion(env: Env): Promise<string> {
  if (tokenCacheado && tokenCacheado.expira > Date.now() + 5 * 60 * 1000) {
    return tokenCacheado.token;
  }
  const jwt = await jwtDeApp(env);
  const respuesta = await fetch(
    `${API}/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': UA,
      },
    },
  );
  if (!respuesta.ok) {
    throw new Error(
      `No se pudo obtener el installation token (${respuesta.status}): ${await respuesta.text()}`,
    );
  }
  const datos = (await respuesta.json()) as { token: string; expires_at: string };
  tokenCacheado = { token: datos.token, expira: Date.parse(datos.expires_at) };
  return datos.token;
}

async function peticionGitHub(
  env: Env,
  ruta: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await tokenDeInstalacion(env);
  return fetch(`${API}${ruta}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
  });
}

export interface DatosIssue {
  titulo: string;
  cuerpo: string;
  severidad: Severidad;
}

/** Crea el issue en el repo de soporte. Devuelve el numero asignado. */
export async function crearIssue(env: Env, datos: DatosIssue): Promise<number> {
  const respuesta = await peticionGitHub(
    env,
    `/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/issues`,
    {
      method: 'POST',
      body: JSON.stringify({
        title: datos.titulo,
        body: datos.cuerpo,
        labels: ['estado:enviada', `severidad:${datos.severidad}`],
      }),
    },
  );
  if (!respuesta.ok) {
    throw new Error(
      `GitHub rechazo la creacion del issue (${respuesta.status}): ${await respuesta.text()}`,
    );
  }
  const issue = (await respuesta.json()) as { number: number };
  return issue.number;
}

/**
 * Cambia la etiqueta de estado del issue: quita la anterior y pone la nueva.
 *
 * Hay que quitar la vieja, no solo anadir: `estadoDesdePayload` recorre las
 * etiquetas y se queda con la primera que reconoce, y GitHub no garantiza el
 * orden del array. Con `estado:enviada` y `estado:analizada` a la vez, el
 * estado que ve el usuario dependeria del azar.
 *
 * Si la etiqueta nueva no existe en el repo, GitHub la crea al asignarla.
 *
 * Esto es lo mas parecido a «el agente se asigna la incidencia» que permite
 * GitHub: una GitHub App no puede figurar como `assignee`, ese campo solo
 * admite cuentas de persona. La etiqueta deja la misma marca visible en el
 * tablero del mantenedor.
 */
export async function reemplazarEtiquetaDeEstado(
  env: Env,
  numero: number,
  anterior: string,
  nueva: string,
): Promise<void> {
  const base = `/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/issues/${numero}`;

  // Un 404 aqui es lo normal si la etiqueta anterior ya no estaba puesta.
  await peticionGitHub(env, `${base}/labels/${encodeURIComponent(anterior)}`, {
    method: 'DELETE',
  }).catch(() => undefined);

  const respuesta = await peticionGitHub(env, `${base}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels: [nueva] }),
  });
  if (!respuesta.ok) {
    console.warn('[github] no se pudo etiquetar el issue', numero, respuesta.status);
  }
}

/**
 * Anade un comentario al issue. Se usa para la hipotesis tecnica de la IA, que
 * va separada del cuerpo para que se lea como lo que es: una sugerencia; para
 * la respuesta del agente, que si llega al usuario; y para los mensajes que el
 * usuario escribe desde la app.
 *
 * Devuelve si GitHub lo acepto. Casi todas las llamadas pueden ignorarlo (un
 * comentario perdido no invalida el ticket), pero el mensaje del usuario si
 * necesita saberlo: si no llega a GitHub, nadie del equipo lo va a leer.
 */
export async function comentarIssue(
  env: Env,
  numero: number,
  texto: string,
): Promise<boolean> {
  const respuesta = await peticionGitHub(
    env,
    `/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/issues/${numero}/comments`,
    { method: 'POST', body: JSON.stringify({ body: texto }) },
  );
  if (!respuesta.ok) {
    console.warn('[github] no se pudo comentar el issue', numero, respuesta.status);
    return false;
  }
  return true;
}

/**
 * Abre o cierra el issue.
 *
 * Lo usa la confirmacion de resolucion: `estado:resuelta` lo pone el equipo,
 * pero mientras la persona que reporto el fallo no diga que ya le funciona es
 * una propuesta, no un cierre. Al confirmar se cierra el issue de verdad; si
 * responde que sigue fallando se reabre y vuelve a `estado:curso`.
 *
 * Devuelve si GitHub lo acepto: quien reabre necesita saberlo, porque dejar la
 * incidencia en curso en KV con el issue cerrado la esconde del equipo.
 */
export async function cambiarAperturaDelIssue(
  env: Env,
  numero: number,
  abierto: boolean,
): Promise<boolean> {
  const respuesta = await peticionGitHub(
    env,
    `/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/issues/${numero}`,
    { method: 'PATCH', body: JSON.stringify({ state: abierto ? 'open' : 'closed' }) },
  );
  if (!respuesta.ok) {
    console.warn('[github] no se pudo cambiar la apertura del issue', numero, respuesta.status);
    return false;
  }
  return true;
}
