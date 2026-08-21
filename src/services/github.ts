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

/**
 * La clave privada de la App llega como secreto, con los saltos de linea
 * escapados si se pego en la consola de Cloudflare.
 */
function normalizarClave(clave: string): string {
  return clave.includes('\\n') ? clave.replace(/\\n/g, '\n') : clave;
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
 * Anade un comentario al issue. Se usa para la hipotesis tecnica de la IA, que
 * va separada del cuerpo para que se lea como lo que es: una sugerencia.
 */
export async function comentarIssue(
  env: Env,
  numero: number,
  texto: string,
): Promise<void> {
  const respuesta = await peticionGitHub(
    env,
    `/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/issues/${numero}/comments`,
    { method: 'POST', body: JSON.stringify({ body: texto }) },
  );
  if (!respuesta.ok) {
    // Un comentario fallido no invalida el ticket: se registra y se sigue.
    console.warn('[github] no se pudo comentar el issue', numero, respuesta.status);
  }
}
