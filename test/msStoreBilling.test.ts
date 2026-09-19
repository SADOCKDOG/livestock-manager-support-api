/**
 * Interpretacion de la respuesta de la API de colecciones de Microsoft.
 * Sin red: se prueba contra respuestas grabadas.
 *
 *   node --test test/
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  interpretarColeccion,
  licenciaVivaSegunAlmacen,
} from '../src/services/msStoreBilling.ts';

const AHORA = Date.parse('2026-09-03T12:00:00.000Z');
const INSTALACION = '35e52bca-aa09-4d81-9a33-44b358bab7c3';

function elemento(extra: Record<string, unknown> = {}) {
  return {
    inAppOfferToken: 'support_unlock',
    productId: '9NBLGGH4XXXX',
    orderId: 'a1b2c3d4-0000-1111-2222-333344445555',
    transactionId: 'f0f0f0f0-9999-8888-7777-666655554444',
    status: 'Active',
    startDate: '2026-09-01T00:00:00.000Z',
    endDate: '2027-09-01T00:00:00.000Z',
    acquiredDate: '2026-09-01T00:00:00.000Z',
    purchaser: { identityType: 'b2b', identityValue: INSTALACION },
    ...extra,
  };
}

test('suscripcion activa y vigente: concede licencia', () => {
  const r = interpretarColeccion([elemento()], AHORA);
  assert.equal(r.activa, true);
  assert.equal(r.expira, '2027-09-01T00:00:00.000Z');
  assert.equal(r.order_id, 'a1b2c3d4-0000-1111-2222-333344445555');
  assert.equal(r.instalacion_declarada, INSTALACION);
  assert.equal(r.es_suscripcion, true);
});

test('microsoft no encadena compras: token_anterior siempre null', () => {
  const r = interpretarColeccion([elemento()], AHORA);
  assert.equal(r.token_anterior, null);
});

test('coleccion vacia: no hay compra', () => {
  const r = interpretarColeccion([], AHORA);
  assert.equal(r.activa, false);
  assert.equal(r.order_id, null);
});

test('otro complemento del mismo comprador: se ignora', () => {
  const r = interpretarColeccion([elemento({ inAppOfferToken: 'premium_unlock' })], AHORA);
  assert.equal(r.activa, false);
});

test('caducada: no concede, pero conserva el orderId para reencontrar al usuario', () => {
  const r = interpretarColeccion([elemento({ endDate: '2026-08-01T00:00:00.000Z' })], AHORA);
  assert.equal(r.activa, false);
  assert.equal(r.order_id, 'a1b2c3d4-0000-1111-2222-333344445555');
});

test('revocada: deniega aunque la fecha sea futura', () => {
  const r = interpretarColeccion([elemento({ status: 'Revoked' })], AHORA);
  assert.equal(r.activa, false);
  assert.match(r.motivo ?? '', /revocada|reembols/i);
});

test('baneada: deniega', () => {
  const r = interpretarColeccion([elemento({ status: 'Banned' })], AHORA);
  assert.equal(r.activa, false);
});

test('estado desconocido: deniega, no se presume', () => {
  const r = interpretarColeccion([elemento({ status: 'Fiesta' })], AHORA);
  assert.equal(r.activa, false);
});

// `PUR-UserAlreadyOwnsContent` no es un estado documentado de la coleccion (los
// validos son Active, Expired, Revoked y Banned): es el mensaje que la Store da
// al comprador que ya posee el complemento. Se acepta como tolerancia, pero sin
// relajar el resto de comprobaciones.

test('ya poseida (PUR-UserAlreadyOwnsContent): concede licencia', () => {
  const r = interpretarColeccion([elemento({ status: 'PUR-UserAlreadyOwnsContent' })], AHORA);
  assert.equal(r.activa, true);
  assert.equal(r.order_id, 'a1b2c3d4-0000-1111-2222-333344445555');
  assert.equal(r.instalacion_declarada, INSTALACION);
});

test('ya poseida pero caducada: deniega', () => {
  const r = interpretarColeccion(
    [elemento({ status: 'PUR-UserAlreadyOwnsContent', endDate: '2026-08-01T00:00:00.000Z' })],
    AHORA,
  );
  assert.equal(r.activa, false);
});

test('ya poseida pero sin endDate: no se presume perpetua', () => {
  const r = interpretarColeccion(
    [elemento({ status: 'PUR-UserAlreadyOwnsContent', endDate: undefined })],
    AHORA,
  );
  assert.equal(r.activa, false);
});

test('ya poseida convive con una activa: gana la que caduca mas tarde', () => {
  const r = interpretarColeccion(
    [
      elemento({
        status: 'PUR-UserAlreadyOwnsContent',
        endDate: '2026-10-01T00:00:00.000Z',
        orderId: 'poseida',
      }),
      elemento({ status: 'Active', endDate: '2027-09-01T00:00:00.000Z', orderId: 'activa' }),
    ],
    AHORA,
  );
  assert.equal(r.activa, true);
  assert.equal(r.order_id, 'activa');
});

test('sin endDate: se toma como no vigente, no como perpetua', () => {
  const r = interpretarColeccion([elemento({ endDate: undefined })], AHORA);
  assert.equal(r.activa, false);
});

test('dos compras del mismo complemento: gana la que caduca mas tarde', () => {
  const r = interpretarColeccion(
    [
      elemento({ endDate: '2026-10-01T00:00:00.000Z', orderId: 'vieja' }),
      elemento({ endDate: '2027-09-01T00:00:00.000Z', orderId: 'nueva' }),
    ],
    AHORA,
  );
  assert.equal(r.activa, true);
  assert.equal(r.order_id, 'nueva');
});

test('un revocado que caduca mas tarde no tapa a la compra activa', () => {
  // Reembolso de una anual y recontratacion mensual: el revocado tiene el
  // endDate mas lejano. Ordenar solo por fecha denegaria la licencia a quien
  // acaba de pagar.
  const r = interpretarColeccion(
    [
      elemento({ status: 'Revoked', endDate: '2027-09-01T00:00:00.000Z', orderId: 'reembolsada' }),
      elemento({ status: 'Active', endDate: '2026-10-01T00:00:00.000Z', orderId: 'mensual' }),
    ],
    AHORA,
  );
  assert.equal(r.activa, true);
  assert.equal(r.order_id, 'mensual');
});

test('sin ninguna activa, el revocado sigue explicando el motivo y da el ancla', () => {
  const r = interpretarColeccion(
    [elemento({ status: 'Revoked', endDate: '2027-09-01T00:00:00.000Z' })],
    AHORA,
  );
  assert.equal(r.activa, false);
  assert.match(r.motivo ?? '', /revocada|reembolsada/);
  assert.equal(r.instalacion_declarada, INSTALACION);
});

test('varias activas: entre ellas sigue ganando la que caduca mas tarde', () => {
  const r = interpretarColeccion(
    [
      elemento({ endDate: '2026-10-01T00:00:00.000Z', orderId: 'corta' }),
      elemento({ endDate: '2027-09-01T00:00:00.000Z', orderId: 'larga' }),
      elemento({ status: 'Revoked', endDate: '2028-01-01T00:00:00.000Z', orderId: 'revocada' }),
    ],
    AHORA,
  );
  assert.equal(r.activa, true);
  assert.equal(r.order_id, 'larga');
});

// --- licenciaVivaSegunAlmacen ------------------------------------------------
// Es el freno que impide adoptar la identidad de alguien con la licencia viva.
// En Windows la instalacion que declara el cliente no la valida nadie, asi que
// sin este freno bastaria con declarar la instalacion ajena para heredar su
// historial de incidencias.

test('la licencia del anterior consta viva si no ha caducado', () => {
  const r = licenciaVivaSegunAlmacen(
    { licencia_soporte_activa: true, licencia_expira: '2026-10-01T00:00:00.000Z' },
    AHORA,
  );
  assert.equal(r.activa, true);
});

test('caducada: se puede adoptar la identidad, que es la reinstalacion legitima', () => {
  const r = licenciaVivaSegunAlmacen(
    { licencia_soporte_activa: true, licencia_expira: '2026-08-01T00:00:00.000Z' },
    AHORA,
  );
  assert.equal(r.activa, false);
});

test('sin fecha de caducidad se frena: ante la duda, no se adopta', () => {
  assert.equal(
    licenciaVivaSegunAlmacen({ licencia_soporte_activa: true, licencia_expira: null }, AHORA).activa,
    true,
  );
  assert.equal(
    licenciaVivaSegunAlmacen({ licencia_soporte_activa: true, licencia_expira: 'vaya' }, AHORA)
      .activa,
    true,
  );
});

test('sin usuario o con la licencia apagada no hay nada que frenar', () => {
  assert.equal(licenciaVivaSegunAlmacen(null, AHORA).activa, false);
  assert.equal(
    licenciaVivaSegunAlmacen(
      { licencia_soporte_activa: false, licencia_expira: '2027-01-01T00:00:00.000Z' },
      AHORA,
    ).activa,
    false,
  );
});
