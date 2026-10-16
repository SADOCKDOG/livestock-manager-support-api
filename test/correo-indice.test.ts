/**
 * Pruebas del retiro del indice `email:` al cambiar el correo en Ajustes.
 *
 * El caso que motiva el fichero se vio en produccion el 2026-10-16: con la
 * licencia viva, `guardarUsuario` escribia el indice del correo nuevo pero
 * dejaba el del anterior apuntando al mismo user_id, de modo que buscar por el
 * correo viejo encontraba igual. El indice solo se retiraba en la rama de
 * licencia NO viva.
 *
 * Se prueba contra la misma interfaz que usa la ruta (ver
 * `guardarUsuarioYRetirarCorreoAnterior`, src/routes/auth.ts) y no contra
 * `Almacen` a proposito: `Almacen` usa parameter properties de TypeScript, que
 * el borrado de tipos de Node no soporta en los tests, y las demas pruebas del
 * repo hacen lo mismo con `LecturaIdentidad`.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Usuario } from '../src/types.ts';

const USER_ID = '14178bc3012cb769a3f061a41de05a21';
const VIEJO = 'viejo@ejemplo.es';
const NUEVO = 'nuevo@ejemplo.es';

function ficha(email: string): Usuario {
  return {
    user_id: USER_ID,
    email,
    plataforma: 'windows',
    purchase_token: 'mdr:0:abc:def',
    instalacion_id: 'inst-1',
    licencia_soporte_activa: true,
    licencia_expira: '2026-11-15T23:59:59.000Z',
  };
}

/** Lo unico que necesita la ruta: guardar, leer y retirar el indice de correo. */
interface Indice {
  usuarios: Map<string, Usuario>;
  emails: Map<string, string>;
  guardados: Usuario[];
  retirados: string[];
}

function almacen(indice: Indice, usuario: Usuario) {
  return {
    async obtenerUsuario(userId: string) {
      return indice.usuarios.get(userId) ?? null;
    },
    async guardarUsuario(u: Usuario) {
      indice.usuarios.set(u.user_id, u);
      indice.guardados.push(u);
      if (u.email) indice.emails.set(u.email.toLowerCase(), u.user_id);
    },
    async retirarIndiceEmail(email: string, userId: string) {
      indice.retirados.push(email);
      // Solo se borra si sigue apuntando a este usuario.
      if (indice.emails.get(email.toLowerCase()) === userId) {
        indice.emails.delete(email.toLowerCase());
      }
    },
  };
}

/** Reproduce `guardarUsuarioYRetirarCorreoAnterior` de src/routes/auth.ts. */
async function guardarYRetirar(
  indice: Indice,
  usuario: Usuario,
  actualizandoEmail: boolean,
): Promise<void> {
  const a = almacen(indice, usuario);
  if (!actualizandoEmail) {
    await a.guardarUsuario(usuario);
    return;
  }
  const base = await a.obtenerUsuario(usuario.user_id);
  await a.guardarUsuario(usuario);
  if (base?.email && base.email !== usuario.email) {
    await a.retirarIndiceEmail(base.email, usuario.user_id);
  }
}

function indiceCon(correo: string): Indice {
  const usuarios = new Map<string, Usuario>();
  const emails = new Map<string, string>();
  if (correo) {
    usuarios.set(USER_ID, ficha(correo));
    emails.set(correo.toLowerCase(), USER_ID);
  }
  return { usuarios, emails, guardados: [], retirados: [] };
}

test('cambiar el correo con licencia viva retira el indice del anterior', async () => {
  const indice = indiceCon(VIEJO);

  await guardarYRetirar(indice, ficha(NUEVO), true);

  assert.equal(indice.emails.has(VIEJO), false, 'el indice viejo debe retirarse');
  assert.equal(indice.emails.get(NUEVO), USER_ID);
  assert.deepEqual(indice.retirados, [VIEJO]);
});

test('al cambiar el correo no se pierde la licencia recien verificada', async () => {
  // Regresion: la via antigua hacia `{...base, email}`, con lo que se pisaban
  // el purchase_token y la caducidad que acababa de confirmar la Store.
  const indice = indiceCon(VIEJO);

  await guardarYRetirar(indice, ficha(NUEVO), true);

  const guardado = indice.usuarios.get(USER_ID);
  assert.equal(guardado?.email, NUEVO);
  assert.equal(guardado?.licencia_expira, '2026-11-15T23:59:59.000Z');
  assert.equal(guardado?.purchase_token, 'mdr:0:abc:def');
  assert.equal(guardado?.licencia_soporte_activa, true);
});

test('un arranque normal NO retira el indice guardado', async () => {
  // Sin `actualizar_email` el correo va vacio: borrar aqui dejaria al usuario
  // sin indice, que es justo lo que hace perder el contacto por correo.
  const indice = indiceCon(NUEVO);

  await guardarYRetirar(indice, { ...ficha(''), email: '' }, false);

  assert.equal(indice.emails.get(NUEVO), USER_ID, 'el indice debe seguir ahi');
  assert.deepEqual(indice.retirados, [], 'no se debe retirar nada');
});

test('ficha nueva sin correo previo: guarda y no toca nada', async () => {
  const indice = indiceCon('');

  await guardarYRetirar(indice, ficha(NUEVO), true);

  assert.equal(indice.usuarios.get(USER_ID)?.email, NUEVO);
  assert.deepEqual(indice.retirados, [], 'no hay indice viejo que retirar');
});

test('el indice viejo solo se retira si sigue siendo suyo', async () => {
  // Si otro usuario registro antes ese mismo correo, su indice no se toca.
  const indice = indiceCon(VIEJO);
  indice.emails.set(VIEJO, 'otro-user-id');

  await guardarYRetirar(indice, ficha(NUEVO), true);

  assert.equal(indice.emails.get(VIEJO), 'otro-user-id');
});
