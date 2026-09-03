/**
 * Pruebas de `resolverIdentidad`. Se ejecutan con el borrado de tipos nativo de
 * Node (>= 22):  node --test test/
 *
 * El caso que motiva el fichero es el ultimo: perder el historial al recomprar.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolverIdentidad } from '../src/services/identidad.ts';
import type { LecturaIdentidad } from '../src/services/identidad.ts';
import type { Usuario } from '../src/types.ts';

const INSTALACION = '35e52bca-aa09-4d81-9a33-44b358bab7c3';

function usuario(userId: string, purchaseToken: string): Usuario {
  return {
    user_id: userId,
    email: 'ganadero@ejemplo.es',
    plataforma: 'android',
    purchase_token: purchaseToken,
    instalacion_id: INSTALACION,
    licencia_soporte_activa: true,
    licencia_expira: '2026-10-01T00:00:00.000Z',
  };
}

function lectura(
  usuarios: Record<string, Usuario>,
  instalaciones: Record<string, string>,
): LecturaIdentidad {
  return {
    async obtenerUsuario(id) {
      return usuarios[id] ?? null;
    },
    async obtenerUsuarioPorInstalacion(id) {
      return instalaciones[id] ?? null;
    },
  };
}

const nuncaSeConsulta = async () => {
  throw new Error('no deberia consultarse la licencia anterior');
};

test('instalacion nueva: se vincula al usuario del token', async () => {
  const r = await resolverIdentidad({
    lectura: lectura({}, {}),
    userIdDelToken: 'nuevo',
    purchaseToken: 'tok-nuevo',
    instalacion: INSTALACION,
    comprobarLicencia: nuncaSeConsulta,
  });
  assert.equal(r.userId, 'nuevo');
  assert.equal(r.vincularInstalacion, true);
});

test('usuario ya conocido: conserva su identidad', async () => {
  const r = await resolverIdentidad({
    lectura: lectura({ viejo: usuario('viejo', 'tok') }, { [INSTALACION]: 'viejo' }),
    userIdDelToken: 'viejo',
    purchaseToken: 'tok',
    instalacion: INSTALACION,
    comprobarLicencia: nuncaSeConsulta,
  });
  assert.equal(r.userId, 'viejo');
});

test('licencia anterior caducada: adopta el historial', async () => {
  const r = await resolverIdentidad({
    lectura: lectura({ viejo: usuario('viejo', 'tok-viejo') }, { [INSTALACION]: 'viejo' }),
    userIdDelToken: 'nuevo',
    purchaseToken: 'tok-nuevo',
    instalacion: INSTALACION,
    comprobarLicencia: async () => ({ activa: false }),
  });
  assert.equal(r.userId, 'viejo');
  assert.equal(r.motivo, 'licencia-anterior-caducada');
});

test('recompra encadenada por Google: adopta aunque la vieja siga viva', async () => {
  const r = await resolverIdentidad({
    lectura: lectura({ viejo: usuario('viejo', 'tok-viejo') }, { [INSTALACION]: 'viejo' }),
    userIdDelToken: 'nuevo',
    purchaseToken: 'tok-nuevo',
    instalacion: INSTALACION,
    tokenEncadenado: 'tok-viejo',
    comprobarLicencia: nuncaSeConsulta,
  });
  assert.equal(r.userId, 'viejo');
  assert.equal(r.motivo, 'recompra-encadenada');
});

test('copia de seguridad ajena: usuario nuevo y vacio', async () => {
  const r = await resolverIdentidad({
    lectura: lectura({ otro: usuario('otro', 'tok-otro') }, { [INSTALACION]: 'otro' }),
    userIdDelToken: 'nuevo',
    purchaseToken: 'tok-nuevo',
    instalacion: INSTALACION,
    comprobarLicencia: async () => ({ activa: true }),
  });
  assert.equal(r.userId, 'nuevo');
  assert.equal(r.existente, null);
});

// --- El fallo reportado -----------------------------------------------------

test('negar la adopcion no puede romper el enlace de la instalacion', async () => {
  const r = await resolverIdentidad({
    lectura: lectura({ viejo: usuario('viejo', 'tok-viejo') }, { [INSTALACION]: 'viejo' }),
    userIdDelToken: 'nuevo',
    purchaseToken: 'tok-nuevo',
    instalacion: INSTALACION,
    comprobarLicencia: async () => ({ activa: true }),
  });
  assert.equal(
    r.vincularInstalacion,
    false,
    'reescribir instalacion:<id> hacia el usuario vacio deja el historial inalcanzable para siempre',
  );
});

test('si Google no responde, tampoco se rompe el enlace', async () => {
  const r = await resolverIdentidad({
    lectura: lectura({ viejo: usuario('viejo', 'tok-viejo') }, { [INSTALACION]: 'viejo' }),
    userIdDelToken: 'nuevo',
    purchaseToken: 'tok-nuevo',
    instalacion: INSTALACION,
    comprobarLicencia: async () => {
      throw new Error('502');
    },
  });
  assert.equal(r.vincularInstalacion, false, 'el reintento del proximo arranque necesita el enlace');
  assert.equal(r.motivo, 'comprobacion-fallida');
});

test('un usuario conocido no se queda con el enlace de otro', async () => {
  const r = await resolverIdentidad({
    lectura: lectura(
      { yo: usuario('yo', 'tok-yo'), otro: usuario('otro', 'tok-otro') },
      { [INSTALACION]: 'otro' },
    ),
    userIdDelToken: 'yo',
    purchaseToken: 'tok-yo',
    instalacion: INSTALACION,
    comprobarLicencia: nuncaSeConsulta,
  });
  assert.equal(r.userId, 'yo');
  assert.equal(r.vincularInstalacion, false);
});
