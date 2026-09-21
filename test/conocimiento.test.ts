/**
 * Pruebas de `recuperarConocimiento`. Sin red.
 *
 *   node --test test/
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { recuperarConocimiento } from '../src/services/conocimiento.ts';

test('un texto sobre historiales por plataforma devuelve ese fragmento', () => {
  const resultado = recuperarConocimiento(
    'en el movil no veo los animales que guarde en el ordenador, son historiales distintos',
  );
  assert.ok(resultado.toLowerCase().includes('plataforma'), 'deberia traer el fragmento de plataformas');
  assert.ok(resultado.toLowerCase().includes('no unifica'), 'deberia citar que no unifica historiales');
});

test('un texto sobre estados de la incidencia conecta con como se lleva una', () => {
  const resultado = recuperarConocimiento('ya me funciona el fallo, la incidencia esta resuelta');
  assert.ok(resultado.includes('Como se lleva una incidencia'), 'deberia traer ese fragmento');
});

test('un texto sin relacion no aporta conocimiento', () => {
  const resultado = recuperarConocimiento('zzz qqq www rrr 123');
  assert.equal(resultado, '');
});
