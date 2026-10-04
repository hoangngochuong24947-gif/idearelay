import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import { FileStore } from '@tus/file-store';
import { Server as TusServer, type Upload } from '@tus/server';
import { AUDIO_EXTENSIONS } from '../util/media.js';

/** The single mobile-facing upload route (spec §11). */
export const TUS_PATH = '/upload';

/**
 * `Upload-Metadata` contract (spec §11, §13 step 2–3). Per the tus protocol,
 * each value is base64-encoded, comma separated:
 *
 *   Upload-Metadata: filename <b64("sample.m4a")>, filetype <b64("audio/mp4")>
 *
 * - `filename` (required): client-side file name. Only its extension is used —
 *   it must be one of the consume-folder audio extensions or creation is
 *   rejected with 400.
 * - `filetype` (required): MIME type. Must start with `audio/` or creation is
 *   rejected with 400.
 *
 * The inbox file is named `<tus-upload-id>.<ext-from-filename>`. The id is
 * stable for the lifetime of the upload (including resumable PATCHes across
 * process restarts), so a resumed upload always lands as the same inbox file.
 * Re-uploading identical content under a new id stays idempotent at the
 * recording level: the intake dedupes on the audio checksum.
 */
export interface TusEndpointOptions {
  /** tus data-store directory, e.g. `data/tus-uploads/`. */
  tusDir: string;
  /** Consume folder the completed upload is atomically moved into. */
  inboxDir: string;
  log?: (message: string) => void;
}

export interface TusEndpoint {
  server: TusServer;
  handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void>;
}

/** Rejection shape consumed by @tus/server's onError (`status_code`/`body`). */
function tusError(statusCode: number, body: string): Error & { status_code: number; body: string } {
  const error = new Error(body) as Error & { status_code: number; body: string };
  error.status_code = statusCode;
  error.body = `${body}\n`;
  return error;
}

/**
 * Validate the metadata contract; returns the target inbox extension.
 * `@tus/server` has already base64-decoded `Upload-Metadata` into
 * `upload.metadata` (`Record<string, string | null>`).
 */
function validateUploadMetadata(upload: Upload): string {
  const filename = upload.metadata?.filename ?? '';
  const filetype = upload.metadata?.filetype ?? '';

  if (filename === '') {
    throw tusError(400, 'invalid Upload-Metadata: missing filename');
  }
  const ext = extname(filename).toLowerCase();
  if (!AUDIO_EXTENSIONS.includes(ext)) {
    throw tusError(
      400,
      `invalid Upload-Metadata: filename extension must be one of ${AUDIO_EXTENSIONS.join(' ')}`,
    );
  }
  if (!filetype.startsWith('audio/')) {
    throw tusError(400, 'invalid Upload-Metadata: filetype must be an audio/* MIME type');
  }
  return ext;
}

/**
 * The tus endpoint (spec §11, §13 step 3): `@tus/server` + `@tus/file-store`
 * under `<dataDir>/tus-uploads/`, with an `onUploadFinish` hand-off that
 * atomically `mv`s the completed audio into the consume folder so the existing
 * watcher + pipeline take over unchanged. The tus metadata sidecar (`<id>.json`)
 * is removed at the same time, leaving the tus store clean.
 */
export function createTusEndpoint(opts: TusEndpointOptions): TusEndpoint {
  const server = new TusServer({
    path: TUS_PATH,
    datastore: new FileStore({ directory: opts.tusDir }),
    onUploadCreate(_req, upload): Promise<{ metadata?: Upload['metadata'] }> {
      validateUploadMetadata(upload);
      return Promise.resolve({});
    },
    onUploadFinish(_req, upload): Promise<{ status_code?: number; body?: string }> {
      const source = upload.storage?.path ?? join(opts.tusDir, upload.id);
      const ext = validateUploadMetadata(upload);
      const dest = join(opts.inboxDir, `${upload.id}${ext}`);

      // Idempotent: the final PATCH is the only completion path in practice,
      // but creation-with-upload can also finish an upload; a repeated call
      // must not clobber the moved file.
      if (existsSync(source)) {
        try {
          renameSync(source, dest);
        } catch {
          // Cross-device fallback: rename fails across mounts, copy+remove instead.
          copyFileSync(source, dest);
          rmSync(source, { force: true });
        }
      }
      rmSync(`${join(opts.tusDir, upload.id)}.json`, { force: true });
      opts.log?.(
        `tus: upload finished id=${upload.id} bytes=${upload.size} → inbox/${upload.id}${ext}`,
      );
      return Promise.resolve({});
    },
  });

  return {
    server,
    handle(req, res) {
      return server.handle(req, res);
    },
  };
}
