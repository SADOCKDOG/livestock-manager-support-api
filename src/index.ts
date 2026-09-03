/**
 * Worker de soporte de Livestock Manager.
 *
 * Recibe incidencias desde la app, las estructura con IA y crea issues en el
 * repo de soporte. Nunca genera commits, ramas ni pull requests: el mantenedor
 * no tiene nada que aprobar, solo lee y responde.
 *
 * Rutas:
 *   POST /auth/verify-purchase   verifica la compra y emite sesion
 *   GET  /auth/me                estado de la licencia
 *   POST /tickets                estructura el reporte (devuelve borrador)
 *   POST /tickets/confirm        crea el issue tras validarlo el usuario
 *   GET  /tickets                incidencias propias
 *   GET  /tickets/:id            detalle de una incidencia
 *   POST /webhooks/github        cambios de estado desde GitHub (HMAC)
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import auth from './routes/auth';
import tickets from './routes/tickets';
import webhooks from './routes/webhooks';
import type { Env, Variables } from './types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Origenes permitidos. La app Android usa https://localhost (Capacitor) y la
 * PWA su dominio de Pages. El webhook de GitHub no pasa por CORS.
 */
const ORIGENES = [
  'https://localhost',
  'capacitor://localhost',
  'http://localhost:8080',
  'http://localhost:8088',
  'https://sadockdog.github.io',
  // La app de escritorio (Tauri 2) sirve el frontend desde su propio origen.
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
];

app.use(
  '/auth/*',
  cors({ origin: ORIGENES, allowMethods: ['POST', 'GET', 'OPTIONS'] }),
);
app.use(
  '/tickets/*',
  cors({
    origin: ORIGENES,
    allowMethods: ['POST', 'GET', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
  }),
);

app.route('/auth', auth);
app.route('/tickets', tickets);
app.route('/webhooks', webhooks);

app.get('/', (c) => c.json({ servicio: 'livestock-manager-support-api', ok: true }));

app.notFound((c) => c.json({ error: 'Ruta no encontrada' }, 404));

app.onError((err, c) => {
  // El detalle va al log; al cliente solo un mensaje generico, para no filtrar
  // como esta montado el backend.
  console.error('[error]', err);
  return c.json({ error: 'Error interno' }, 500);
});

export default app;
