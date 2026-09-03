/**
 * Identidad y licencia.
 *
 *   POST /auth/verify-purchase  -> el cliente manda su purchase_token; aqui se
 *                                  valida contra Google Play y se emite la sesion.
 *   GET  /auth/me               -> estado de la licencia del usuario en sesion.
 *
 * PENDIENTE DE DEFINIR (doc, seccion 11): el proveedor de identidad. De momento
 * la identidad va anclada a la compra, que es lo unico verificable server-side
 * sin montar login. Cuando se decida (Google Sign-In o email+OTP), se anade
 * aqui el endpoint correspondiente y se conserva `emitirSesion`.
 */

import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { verificarLicenciaAndroid } from '../services/playBilling';
import {
  AUDIENCIA_CLAVE_COLECCIONES,
  tokenDeAcceso as tokenEntraID,
  verificarLicenciaWindows,
} from '../services/msStoreBilling';
import { Almacen } from '../services/storage';
import { requiereSesion } from '../middleware/auth';
import { resolverIdentidad } from '../services/identidad';
import { detalleError } from '../utils/errores';
import type { Env, Plataforma, Usuario, Variables } from '../types';

const rutas = new Hono<{ Bindings: Env; Variables: Variables }>();

/** applicationId de la app Android. Debe coincidir con el de Play Console. */
const PAQUETE_ANDROID = 'com.livestockmanager.app.manual';

/** Duracion de la sesion. Corta a proposito: se renueva revalidando la compra. */
const HORAS_SESION = 24;

const codificador = new TextEncoder();

async function emitirSesion(
  secreto: string,
  usuario: Usuario,
): Promise<{ token: string; expira: string }> {
  const expiraEn = new Date(Date.now() + HORAS_SESION * 3600 * 1000);
  const token = await new SignJWT({
    email: usuario.email,
    plataforma: usuario.plataforma,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(usuario.user_id)
    .setIssuedAt()
    .setExpirationTime(expiraEn)
    .sign(codificador.encode(secreto));
  return { token, expira: expiraEn.toISOString() };
}

/**
 * Valida la compra y devuelve la sesion.
 *
 * Se llama tras comprar y en cada arranque de la app: asi una licencia
 * cancelada o reembolsada deja de dar acceso en menos de 24 horas.
 */
rutas.post('/verify-purchase', async (c) => {
  const cuerpo = await c.req.json().catch(() => null);
  const purchaseToken = cuerpo?.purchase_token;
  const plataforma: Plataforma =
    cuerpo?.plataforma === 'web' ? 'web'
    : cuerpo?.plataforma === 'windows' ? 'windows'
    : 'android';
  const email = typeof cuerpo?.email === 'string' ? cuerpo.email.trim().toLowerCase() : '';
  const instalacion =
    typeof cuerpo?.instalacion === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(cuerpo.instalacion)
      ? cuerpo.instalacion
      : '';

  if (typeof purchaseToken !== 'string' || purchaseToken.length < 10) {
    return c.json({ error: 'Falta el token de compra' }, 400);
  }

  if (plataforma === 'web') {
    // PENDIENTE: pago web para la PWA (Stripe u otro). Hasta que se decida el
    // proveedor no se puede verificar nada server-side, y sin verificacion no
    // se concede licencia: preferible negar que regalar el producto de pago.
    return c.json(
      {
        error: 'El pago web todavia no esta disponible',
        codigo: 'PAGO_WEB_NO_CONFIGURADO',
      },
      501,
    );
  }

  if (plataforma === 'windows') {
    // En windows `purchase_token` transporta la Store ID key, no un token de
    // compra: es lo unico que prueba algo, y caduca a los 30 dias.
    const claveStore = purchaseToken;
    if (!c.env.MS_ENTRA_TENANT_ID || !c.env.MS_ENTRA_CLIENT_ID || !c.env.MS_ENTRA_CLIENT_SECRET) {
      return c.json(
        {
          error: 'La compra en Microsoft Store todavia no esta disponible',
          codigo: 'MS_STORE_NO_CONFIGURADO',
        },
        501,
      );
    }

    let licencia;
    try {
      licencia = await verificarLicenciaWindows(
        c.env.MS_ENTRA_TENANT_ID,
        c.env.MS_ENTRA_CLIENT_ID,
        c.env.MS_ENTRA_CLIENT_SECRET,
        claveStore,
      );
    } catch (e) {
      console.error('[auth] fallo la verificacion con Microsoft Store:', detalleError(e));
      return c.json({ error: 'No se pudo verificar la compra ahora mismo' }, 502);
    }

    if (!licencia.activa || !licencia.order_id) {
      return c.json(
        { error: licencia.motivo ?? 'La compra no es valida', codigo: 'COMPRA_NO_VALIDA' },
        403,
      );
    }

    // La instalacion que declaro el cliente al acunar la clave vuelve firmada
    // por Microsoft. Si no coincide con la que dice ahora, manda la que
    // Microsoft confirma.
    const instalacionWin = licencia.instalacion_declarada ?? instalacion;

    const almacen = new Almacen(c.env.TICKETS_KV);
    const userIdDelToken = await hashUserIdWindows(licencia.order_id);
    const { userId, existente, vincularInstalacion, motivo } = await resolverIdentidad({
      lectura: almacen,
      userIdDelToken,
      purchaseToken: licencia.order_id,
      instalacion: instalacionWin,
      // Microsoft no expone equivalente a linkedPurchaseToken: la recompra
      // encadenada nunca se dispara aqui y cae en licencia-anterior-caducada,
      // que es el comportamiento correcto.
      tokenEncadenado: null,
      // No se puede reconsultar una compra ajena: la coleccion se consulta por
      // comprador, no por pedido. La compra anterior de ESTA instalacion estaba
      // en la coleccion que se acaba de leer, asi que si no ha salido como
      // activa es que no lo esta.
      comprobarLicencia: async () => ({ activa: false }),
    });
    if (motivo !== 'usuario-conocido' && motivo !== 'instalacion-nueva') {
      console.log(`[auth] identidad resuelta (windows): ${motivo}`);
    }

    const usuarioWin: Usuario = {
      user_id: userId,
      email: cuerpo?.actualizar_email ? email : email || existente?.email || '',
      plataforma: 'windows',
      purchase_token: licencia.order_id,
      instalacion_id: instalacionWin || existente?.instalacion_id || null,
      licencia_soporte_activa: true,
      licencia_expira: licencia.expira,
    };
    await almacen.guardarUsuario(usuarioWin);
    if (instalacionWin && vincularInstalacion) {
      await almacen.vincularInstalacion(instalacionWin, userId);
    }

    const sesionWin = await emitirSesion(c.env.JWT_SECRET, usuarioWin);
    return c.json({ ...sesionWin, licencia: { activa: true, expira: licencia.expira } });
  }

  let resultado;
  try {
    resultado = await verificarLicenciaAndroid(
      c.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON,
      PAQUETE_ANDROID,
      purchaseToken,
    );
  } catch (e) {
    console.error('[auth] fallo la verificacion con Google Play:', e);
    return c.json({ error: 'No se pudo verificar la compra ahora mismo' }, 502);
  }

  if (!resultado.activa) {
    return c.json(
      { error: resultado.motivo ?? 'La compra no es valida', codigo: 'COMPRA_NO_VALIDA' },
      403,
    );
  }

  // La identidad se ancla al token de compra: es estable y lo emite Google.
  // Anclarla solo al token tiene un agujero: cuando la suscripcion caduca y se
  // vuelve a comprar, Google emite otro purchase_token, el hash cambia y el
  // ganadero aparece como usuario nuevo con el historial de incidencias vacio.
  // El id de instalacion lo arregla porque vive en la base de datos de la app,
  // que la recompra no toca. La decision esta en services/identidad.ts.
  const almacen = new Almacen(c.env.TICKETS_KV);
  const userIdDelToken = await hashUserId(purchaseToken);
  const { userId, existente, vincularInstalacion, motivo } = await resolverIdentidad({
    lectura: almacen,
    userIdDelToken,
    purchaseToken,
    instalacion,
    tokenEncadenado: resultado.token_anterior,
    comprobarLicencia: (token) =>
      verificarLicenciaAndroid(c.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, PAQUETE_ANDROID, token),
  });
  if (motivo !== 'usuario-conocido' && motivo !== 'instalacion-nueva') {
    console.log(`[auth] identidad resuelta: ${motivo}`);
  }

  const usuario: Usuario = {
    user_id: userId,
    // `actualizar_email` distingue al usuario editando el campo en Ajustes del
    // arranque normal, que manda el correo vacio y borraria el guardado.
    email: cuerpo?.actualizar_email ? email : email || existente?.email || '',
    plataforma,
    purchase_token: purchaseToken,
    instalacion_id: instalacion || existente?.instalacion_id || null,
    licencia_soporte_activa: true,
    licencia_expira: resultado.expira,
  };
  await almacen.guardarUsuario(usuario);
  // Solo cuando le corresponde a este usuario: ver services/identidad.ts.
  if (instalacion && vincularInstalacion) {
    await almacen.vincularInstalacion(instalacion, userId);
  }

  const sesion = await emitirSesion(c.env.JWT_SECRET, usuario);
  return c.json({
    ...sesion,
    licencia: { activa: true, expira: resultado.expira },
  });
});

/**
 * Ticket de servicio para acunar la Store ID key.
 *
 * El cliente no puede pedirselo el mismo a Entra ID porque haria falta el
 * secreto de cliente, que no sale de aqui. La ruta es abierta pero no concede
 * nada: con el ticket solo se puede acunar una clave para la identidad de
 * Windows de quien llama, y esa clave hay que traerla luego a
 * /auth/verify-purchase para que sirva de algo.
 */
rutas.post('/ms/ticket', async (c) => {
  if (!c.env.MS_ENTRA_TENANT_ID || !c.env.MS_ENTRA_CLIENT_ID || !c.env.MS_ENTRA_CLIENT_SECRET) {
    return c.json(
      {
        error: 'La compra en Microsoft Store todavia no esta disponible',
        codigo: 'MS_STORE_NO_CONFIGURADO',
      },
      501,
    );
  }
  // Limite por IP: la ruta es abierta por necesidad (WinRT necesita el ticket
  // antes de que exista sesion), asi que no hay user_id con el que limitar.
  // Cada ticket es una llamada a Entra ID, y agotar esa cuota deja sin comprar
  // a todo el mundo. El tope es generoso a proposito: la app revalida en cada
  // arranque y varias personas pueden compartir IP.
  const ip = c.req.header('CF-Connecting-IP') ?? '';
  const almacenIP = new Almacen(c.env.TICKETS_KV);
  if (ip) {
    const maximo = parseInt(c.env.MAX_TICKETS_MS_POR_HORA ?? '30', 10) || 30;
    if ((await almacenIP.contarAcunadosDeLaHora(ip)) >= maximo) {
      return c.json(
        {
          error: 'Demasiados intentos. Prueba de nuevo dentro de un rato.',
          codigo: 'LIMITE_TICKETS_MS',
        },
        429,
      );
    }
  }

  try {
    // Audiencia de acunado, no la del servicio: este ticket viaja hasta la app.
    const ticket = await tokenEntraID(
      c.env.MS_ENTRA_TENANT_ID,
      c.env.MS_ENTRA_CLIENT_ID,
      c.env.MS_ENTRA_CLIENT_SECRET,
      AUDIENCIA_CLAVE_COLECCIONES,
    );
    // Se cuenta despues de emitirlo: un fallo de Entra ID no debe gastar cupo.
    if (ip) {
      await almacenIP.incrementarAcunadosDeLaHora(ip);
    }
    return c.json({ ticket });
  } catch (e) {
    console.error('[auth] fallo el ticket de Entra ID:', detalleError(e));
    return c.json({ error: 'No se pudo contactar con Microsoft ahora mismo' }, 502);
  }
});

/** Estado actual de la licencia, para que la app decida que mostrar. */
rutas.get('/me', requiereSesion, async (c) => {
  const usuario = c.get('usuario');
  const caducada = usuario.licencia_expira
    ? Date.parse(usuario.licencia_expira) < Date.now()
    : false;
  return c.json({
    user_id: usuario.user_id,
    email: usuario.email,
    plataforma: usuario.plataforma,
    licencia: {
      activa: usuario.licencia_soporte_activa && !caducada,
      expira: usuario.licencia_expira,
    },
  });
});

async function hashDe(texto: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', codificador.encode(texto));
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * user_id derivado del purchase_token. Se hashea para no usar el token de
 * compra como identificador en claro por todo el almacenamiento.
 */
async function hashUserId(purchaseToken: string): Promise<string> {
  return hashDe(`usuario:${purchaseToken}`);
}

/**
 * user_id de Windows. Se ancla al orderId de la compra en Microsoft Store, que
 * es lo unico estable y por comprador que devuelve la API de colecciones: el
 * purchaseToken de la Digital Goods API es el id del complemento e igual para
 * todo el mundo. El prefijo 'ms:' evita cualquier colision con Android.
 */
async function hashUserIdWindows(orderId: string): Promise<string> {
  return hashDe(`usuario:ms:${orderId}`);
}

export default rutas;
