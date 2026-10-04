import { createServer } from 'node:http';
import type { Server } from 'node:http';

export interface HttpOptions {
  host: string;
  port: number;
  log?: (message: string) => void;
}

export interface HttpHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/**
 * M0 stub: a health endpoint. The mobile-facing API and tus endpoint land later
 * (spec §11).
 */
export async function startHttp(opts: HttpOptions): Promise<HttpHandle> {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
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
  opts.log?.(`http: listening on http://${opts.host}:${port} (GET /health)`);

  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
