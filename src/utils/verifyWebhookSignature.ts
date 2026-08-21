/**
 * Verificacion HMAC de los webhooks de GitHub.
 *
 * GitHub firma cada entrega con SHA-256 en la cabecera X-Hub-Signature-256.
 * Un payload sin firma valida se rechaza sin procesar: si no, cualquiera podria
 * cambiar el estado de los tickets con una peticion.
 */

const codificador = new TextEncoder();

/**
 * Comparacion en tiempo constante. Con una comparacion normal (===) el tiempo
 * de respuesta filtra cuantos bytes coinciden, lo que permite reconstruir la
 * firma byte a byte.
 */
function igualdadConstante(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i++) diferencia |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diferencia === 0;
}

function hexABytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  const salida = new Uint8Array(hex.length / 2);
  for (let i = 0; i < salida.length; i++) {
    salida[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return salida;
}

/**
 * @param cuerpo  Cuerpo crudo de la peticion, tal cual llego. Firmar sobre el
 *                JSON reserializado NO funciona: cambia el orden y el espaciado.
 * @param cabecera Valor de X-Hub-Signature-256, con el prefijo 'sha256='.
 */
export async function firmaWebhookValida(
  cuerpo: string,
  cabecera: string | undefined | null,
  secreto: string,
): Promise<boolean> {
  if (!cabecera || !secreto) return false;
  if (!cabecera.startsWith('sha256=')) return false;

  const recibida = hexABytes(cabecera.slice('sha256='.length));
  if (!recibida) return false;

  const clave = await crypto.subtle.importKey(
    'raw',
    codificador.encode(secreto),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const calculada = new Uint8Array(
    await crypto.subtle.sign('HMAC', clave, codificador.encode(cuerpo)),
  );

  return igualdadConstante(calculada, recibida);
}
