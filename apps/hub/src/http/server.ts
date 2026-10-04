import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { SqliteDb } from '../db/types.js';
import { listRunStages, listWorkflowRuns } from '../db/repositories/workflows.js';
import { getWorkflowRun } from '../db/repositories/workflows.js';
import { TUS_PATH, createTusEndpoint, type TusEndpoint, type TusEndpointOptions } from './tus.js';

export interface HttpOptions {
  host: string;
  port: number;
  /** When present, the `POST /upload` tus endpoint is mounted (spec §11). */
  tus?: TusEndpointOptions;
  /** When present, the M5 run-observation routes are mounted (spec §11). */
  db?: SqliteDb;
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
    // M5 run-observation routes (§11): the phone reads "which stage is the run
    // on, did it hang?" from these.
    if (opts.db !== undefined && req.method === 'GET') {
      const runsMatch = /^\/runs\/([\w-]+)\/stages$/.exec(url);
      if (runsMatch !== null) {
        const run = getWorkflowRun(opts.db, runsMatch[1]);
        if (run === null) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const stages = listRunStages(opts.db, run.id).map((s) => ({
          name: s.name,
          status: s.status,
          started_at: s.started_at,
          ended_at: s.ended_at,
        }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runId: run.id, status: run.status, stages }));
        return;
      }
      if (url === '/runs') {
        const runs = listWorkflowRuns(opts.db).map((r) => ({
          id: r.id,
          spec_id: r.spec_id,
          subject_type: r.subject_type,
          subject_id: r.subject_id,
          status: r.status,
          created_at: r.created_at,
          finished_at: r.finished_at,
        }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runs }));
        return;
      }
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
  const routes = [
    'GET /health',
    tus !== undefined ? 'POST /upload (tus)' : null,
    opts.db !== undefined ? 'GET /runs, GET /runs/:id/stages' : null,
  ].filter((r): r is string => r !== null);
  opts.log?.(`http: listening on http://${opts.host}:${port} (${routes.join(', ')})`);

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
