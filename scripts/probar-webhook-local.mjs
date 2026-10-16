/**
 * probar-webhook-local.mjs — ejercita el webhook de GitHub contra el Worker local.
 *
 * El webhook no llama a la API de GitHub: solo valida la firma HMAC y mueve el
 * estado del ticket en KV. Por eso SI se puede probar entero en local, y es la
 * via de la que dependen las notificaciones de cambio de estado del frontend.
 *
 *   node scripts/probar-webhook-local.mjs [http://127.0.0.1:8788]
 */

import { createHmac } from 'node:crypto';

const BASE = process.argv[2] || 'http://127.0.0.1:8788';
const SECRETO = 'secreto-webhook-local';
const ISSUE = 42;

// Etiqueta que el mantenedor pone en GitHub. El webhook la traduce a estado
// interno: es lo que dispara «Tu incidencia se ha resuelto».
const payload = JSON.stringify({
  action: 'labeled',
  issue: {
    number: ISSUE,
    title: 'Prueba de ciclo de incidencia en local',
    labels: [{ name: 'estado:resuelta' }],
    state: 'closed',
  },
  sender: { type: 'User' },
});

function firmar(cuerpo, secreto) {
  return 'sha256=' + createHmac('sha256', secreto).update(cuerpo, 'utf8').digest('hex');
}

async function enviar(nombre, cuerpo, cabecera, evento) {
  const res = await fetch(`${BASE}/webhooks/github`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': evento,
      'X-Hub-Signature-256': cabecera,
    },
    body: cuerpo,
  });
  console.log(`--- ${nombre} -> HTTP ${res.status}`);
  console.log('   ', await res.text());
}

console.log('Evento del webhook:', payload, '\n');

// 1. Firma invalida: el control de seguridad. Sin esto, cualquiera podria
//    cambiar el estado de los tickets de cualquiera con una peticion suelta.
await enviar('firma invalida', payload, 'sha256=' + '00'.repeat(32), 'issues');

// 2. Firma correcta: mueve el ticket a «resuelta».
await enviar('firma valida (estado:resuelta)', payload, firmar(payload, SECRETO), 'issues');

// 3. Firma valida pero cuerpo vacio de cambios: debe ignorar sin tocar nada.
const sinCambios = JSON.stringify({
  action: 'labeled',
  issue: { number: ISSUE, labels: [{ name: 'sin-etiqueta-de-estado' }] },
  sender: { type: 'User' },
});
await enviar('firma valida (etiqueta sin estado)', sinCambios, firmar(sinCambios, SECRETO), 'issues');
