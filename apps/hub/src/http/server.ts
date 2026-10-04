import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { InboxStatus } from '@idearelay/contracts';
import type { SqliteDb } from '../db/types.js';
import { listRunStages, listWorkflowRuns } from '../db/repositories/workflows.js';
import { getWorkflowRun } from '../db/repositories/workflows.js';
import { listRequirements } from '../db/repositories/requirements.js';
import { listInboxItems } from '../db/repositories/inbox.js';
import {
  InboxActionError,
  acceptInboxItem,
  listInboxChanges,
  rejectInboxItem,
  rerouteInboxItem,
  serializeInboxItem,
} from '../pipeline/inbox-actions.js';
import { TUS_PATH, createTusEndpoint, type TusEndpoint, type TusEndpointOptions } from './tus.js';

const INBOX_STATUSES: readonly InboxStatus[] = ['pending', 'accepted', 'rejected', 'rerouted'];

/** Max JSON body bytes accepted on the inbox action routes. */
const MAX_BODY_BYTES = 1_000_000;

export interface HttpOptions {
  host: string;
  port: number;
  /** When present, the `POST /upload` tus endpoint is mounted (spec §11). */
  tus?: TusEndpointOptions;
  /** When present, the M5 run-observation and M7 inbox routes are mounted (§11). */
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

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Health endpoint plus, when `tus` options are given, the mobile-facing tus
 * upload route (`/upload`, spec §11). With `db`, the M5 run-observation routes
 * and the M7 phone read/write surface (`/inbox`, `/changes`, `/requirements`)
 * are mounted. All other paths 404.
 */
export async function startHttp(opts: HttpOptions): Promise<HttpHandle> {
  const tus = opts.tus ? createTusEndpoint({ ...opts.tus, log: opts.tus.log ?? opts.log }) : undefined;

  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && (url === '/health' || url === '/')) {
      json(res, 200, { status: 'ok' });
      return;
    }
    if (tus !== undefined && (url === TUS_PATH || url.startsWith(`${TUS_PATH}/`))) {
      void tus.handle(req, res);
      return;
    }

    // --- M7 phone surface (spec §11 / §6) --------------------------------
    const actionMatch =
      req.method === 'POST' ? /^\/inbox\/([\w-]+)\/(accept|reject|reroute)$/.exec(url) : null;
    if (opts.db !== undefined && actionMatch !== null) {
      const [, id, action] = actionMatch;
      void (async (): Promise<void> => {
        let body: unknown = null;
        if (action === 'reroute') {
          try {
            const raw = await readBody(req);
            body = raw === '' ? null : (JSON.parse(raw) as unknown);
          } catch {
            json(res, 400, { error: 'bad_request', message: 'invalid JSON body' });
            return;
          }
        }
        try {
          const toKind = action === 'reroute' ? (body as { to_kind?: unknown } | null)?.to_kind : undefined;
          const outcome =
            action === 'accept'
              ? acceptInboxItem(opts.db as SqliteDb, id)
              : action === 'reject'
                ? rejectInboxItem(opts.db as SqliteDb, id)
                : rerouteInboxItem(opts.db as SqliteDb, id, toKind);
          json(res, 200, { ok: true, item: serializeInboxItem(outcome.item) });
        } catch (error) {
          if (error instanceof InboxActionError) {
            json(res, error.status, { error: error.code, message: error.message });
            return;
          }
          json(res, 500, { error: 'internal', message: String(error) });
        }
      })();
      return;
    }

    if (opts.db !== undefined && req.method === 'GET') {
      const parsed = new URL(url, 'http://localhost');
      const pathname = parsed.pathname;

      if (pathname === '/inbox') {
        const statusParam = parsed.searchParams.get('status') ?? 'pending';
        if (!INBOX_STATUSES.includes(statusParam as InboxStatus)) {
          json(res, 400, {
            error: 'bad_request',
            message: `status must be one of: ${INBOX_STATUSES.join(', ')}`,
          });
          return;
        }
        const items = listInboxItems(opts.db, { status: statusParam as InboxStatus }).map(
          serializeInboxItem,
        );
        json(res, 200, { items });
        return;
      }

      if (pathname === '/changes') {
        const sinceRaw = parsed.searchParams.get('since') ?? '0';
        const since = Number.parseInt(sinceRaw, 10);
        if (Number.isNaN(since) || since < 0) {
          json(res, 400, { error: 'bad_request', message: 'since must be epoch ms' });
          return;
        }
        const { changes, deletions } = listInboxChanges(opts.db, since);
        json(res, 200, {
          changes: changes.map(serializeInboxItem),
          deletions,
          timestamp: Date.now(),
        });
        return;
      }

      if (pathname === '/requirements') {
        const requirements = listRequirements(opts.db).map((r) => ({
          id: r.id,
          title: r.title,
          status: r.status,
          body_path: r.body_path,
          created_at: r.created_at,
          source_revision_id: r.source_revision_id,
        }));
        json(res, 200, { requirements });
        return;
      }

      // M5 run-observation routes (§11): the phone reads "which stage is the run
      // on, did it hang?" from these.
      const runsMatch = /^\/runs\/([\w-]+)\/stages$/.exec(pathname);
      if (runsMatch !== null) {
        const run = getWorkflowRun(opts.db, runsMatch[1]);
        if (run === null) {
          json(res, 404, { error: 'not_found' });
          return;
        }
        const stages = listRunStages(opts.db, run.id).map((s) => ({
          name: s.name,
          status: s.status,
          started_at: s.started_at,
          ended_at: s.ended_at,
        }));
        json(res, 200, { runId: run.id, status: run.status, stages });
        return;
      }
      if (pathname === '/runs') {
        const runs = listWorkflowRuns(opts.db).map((r) => ({
          id: r.id,
          spec_id: r.spec_id,
          subject_type: r.subject_type,
          subject_id: r.subject_id,
          status: r.status,
          created_at: r.created_at,
          finished_at: r.finished_at,
        }));
        json(res, 200, { runs });
        return;
      }
    }
    json(res, 404, { error: 'not_found' });
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
    opts.db !== undefined
      ? 'GET /inbox, POST /inbox/:id/{accept,reject,reroute}, GET /changes, GET /requirements, GET /runs, GET /runs/:id/stages'
      : null,
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
