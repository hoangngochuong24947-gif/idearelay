import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { TUS_PATH, createTusEndpoint, type TusEndpoint, type TusEndpointOptions } from './tus.js';

export interface HttpOptions {
  host: string;
  port: number;
  /** When present, the `POST /upload` tus endpoint is mounted (spec §11). */
  tus?: TusEndpointOptions;
  log?: (message: string) => void;
}

export interface HttpHandle {
  server: Server;
  port: number;
  /** The tus endpoint, when mounted. */
  tus?: TusEndpoint;
  close(): Promise<void>;
}

/**
 * Health endpoint plus, when `tus` options are given, the mobile-facing tus
 * upload route (`/upload`, spec §11). All other paths 404.
 */
export async function startHttp(opts: HttpOptions): Promise<HttpHandle> {
  const tus = opts.tus ? createTusEndpoint({ ...opts.tus, log: opts.tus.log ?? opts.log }) : undefined;

  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && (url === '/health' || url === '/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (tus !== undefined && (url === TUS_PATH || url.startsWith(`${TUS_PATH}/`))) {
      void tus.handle(req, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve());
  });

  const address = server.address();
  const port =
    address !== null && typeof address === 'object' ? address.port : opts.port;
  opts.log?.(
    `http: listening on http://${opts.host}:${port} (GET /health${tus ? ', POST /upload (tus)' : ''})`,
  );

  return {
    server,
    port,
    tus,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
