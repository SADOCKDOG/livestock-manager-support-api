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

test('un texto sobre versionado MSIX conecta con el fragmento de versionado', () => {
  const resultado = recuperarConocimiento('no veo los cambios reflejados en el paquete MSIX de la Store');
  assert.ok(resultado.includes('Versionado del paquete MSIX'), 'deberia traer el fragmento de versionado MSIX');
});

test('un texto sobre sync maestro-desktop devuelve el fragmento correspondiente', () => {
  const resultado = recuperarConocimiento('el comando npm run sync no copia mis cambios al desktop');
  assert.ok(resultado.includes('Relacion maestro <-> desktop'), 'deberia traer el fragmento de sync maestro-desktop');
});

test('un texto sobre testing conecta con el fragmento de validacion', () => {
  const resultado = recuperarConocimiento('los tests de Playwright fallan por densidad de pantalla');
  assert.ok(resultado.includes('Testing y validacion'), 'deberia traer el fragmento de testing y validacion');
});

test('un texto sin relacion no aporta conocimiento', () => {
  const resultado = recuperarConocimiento('xyz abc 123');
  assert.equal(resultado, '');
});
