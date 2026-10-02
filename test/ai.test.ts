/**
 * Pruebas del adaptador de respuestas de Workers AI. Sin red.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { redactarRespuestaSeguimiento } from '../src/services/ai.ts';

const hilo = [{ autor: 'usuario' as const, texto: 'Sigue sin funcionar.' }];
const json = JSON.stringify({
  resumen: 'He entendido que la incidencia sigue ocurriendo.',
  comprobaciones: ['Cierra y vuelve a abrir la aplicación.'],
  resuelta: false,
});

function proveedor(respuesta: unknown) {
  return {
    run: async () => respuesta,
  } as never;
}

test('acepta la respuesta directa como cadena', async () => {
  const resultado = await redactarRespuestaSeguimiento(proveedor(json), hilo);
  assert.match(resultado.texto ?? '', /sigue ocurriendo/);
});

test('acepta la respuesta envuelta en response', async () => {
  const resultado = await redactarRespuestaSeguimiento(
    proveedor({ response: json }),
    hilo,
  );
  assert.match(resultado.texto ?? '', /Cierra y vuelve/);
});

test('acepta la respuesta Chat Completions de Workers AI', async () => {
  const resultado = await redactarRespuestaSeguimiento(
    proveedor({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: json } }],
    }),
    hilo,
  );
  assert.match(resultado.texto ?? '', /sigue ocurriendo/);
});

test('devuelve respuesta vacía para una forma inesperada', async () => {
  const resultado = await redactarRespuestaSeguimiento(
    proveedor({ choices: [] }),
    hilo,
  );
  assert.deepEqual(resultado, { texto: null, resuelta: false });
});
