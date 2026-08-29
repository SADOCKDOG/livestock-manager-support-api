/**
 * Texto legible de un error para el log.
 *
 * `console.error('...', e)` en Workers imprime el stack pero se come el
 * mensaje, que es justo la parte que dice QUE ha fallado. Un 502 de
 * `/tickets/confirm` solo dejaba «at importPKCS8 (...)» sin decir por que.
 */
export function detalleError(e: unknown): string {
  if (e instanceof Error) {
    return e.stack ? `${e.message} | ${e.stack.split('\n').slice(0, 4).join(' ')}` : e.message;
  }
  return String(e);
}
