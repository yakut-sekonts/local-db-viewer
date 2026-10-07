import { net } from 'electron';
import { Readable } from 'node:stream';
import type { UpdateFetch } from './update-source';

function responseHeaders(values: Record<string, string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

// net.fetch cancels manual redirects (Electron #43715). net.request exposes the
// redirect response so update-source can validate each destination before sending.
// Chromium provides system proxy/PAC and TLS verification; cookies are not sent.
export const fetchUpdate: UpdateFetch = (url, options) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) { reject(options.signal.reason); return; }
  const request = net.request({ url, method: 'GET', redirect: options.redirect ?? 'error', cache: 'no-store', credentials: options.credentials ?? 'omit', useSessionCookies: false });
  let body: Readable | undefined;
  let settled = false;
  const cleanup = () => options.signal?.removeEventListener('abort', abort);
  const fail = (error: Error) => {
    cleanup();
    if (!settled) { settled = true; reject(error); }
    else body?.destroy(error);
  };
  const abort = () => {
    fail(options.signal?.reason ?? new DOMException('Update request aborted', 'AbortError'));
    request.abort();
  };
  request.on('error', fail);
  // ClientRequest's writable side can emit close immediately after end(),
  // before response headers. Retain cancellation until the response completes.
  request.on('redirect', (status, _method, location, headers) => {
    if (options.redirect !== 'manual') { fail(new Error('ERR_UNSAFE_REDIRECT')); request.abort(); return; }
    const result = responseHeaders(headers); result.set('location', location);
    settled = true;
    cleanup();
    resolve(new Response(null, { status, headers: result }));
    request.abort();
  });
  request.on('response', response => {
    // Electron IncomingMessage implements Readable; its typings expose only events.
    body = response as unknown as Readable;
    if (settled) { body.destroy(); cleanup(); return; }
    body.once('end', cleanup);
    body.once('error', cleanup);
    body.once('close', cleanup);
    body.once('aborted', () => fail(options.signal?.reason ?? new DOMException('Update response aborted', 'AbortError')));
    const stream = Readable.toWeb(body, { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength } }) as ReadableStream<Uint8Array>;
    const result = new Response([204, 205, 304].includes(response.statusCode) ? null : stream, {
      status: response.statusCode, headers: responseHeaders(response.headers),
    });
    settled = true; resolve(result);
    if (!result.body) body.resume();
  });
  options.signal?.addEventListener('abort', abort, { once: true });
  for (const [name, value] of new Headers(options.headers)) request.setHeader(name, value);
  request.end();
});
