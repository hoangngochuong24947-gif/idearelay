import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { bootstrap, type Hub } from './bootstrap.js';
import { loadConfig } from './config/config.js';
import { countRecordings, getRecording } from './db/repositories/recordings.js';
import { getCurrentRevision, listSegments } from './db/repositories/transcripts.js';

const FIXTURE = fileURLToPath(new URL('../test-fixtures/sample.m4a', import.meta.url));
const AUDIO_BYTES = readFileSync(FIXTURE);

interface M4Harness {
  hub: Hub;
  dataDir: string;
  inboxDir: string;
  tusDir: string;
  base: string;
  cleanup(): Promise<void>;
}

async function harness(): Promise<M4Harness> {
  const root = mkdtempSync(join(tmpdir(), 'idearelay-m4-'));
  const dataDir = join(root, 'data');
  const hub = await bootstrap(
    loadConfig({
      IDEA_RELAY_DATA_DIR: dataDir,
      IDEA_RELAY_HTTP_PORT: '0',
      IDEA_RELAY_WORKER_ID: 'm4-test',
      IDEA_RELAY_POLL_INTERVAL_MS: '20',
    }),
    { log: () => undefined },
  );
  return {
    hub,
    dataDir,
    inboxDir: join(dataDir, 'inbox'),
    tusDir: join(dataDir, 'tus-uploads'),
    base: `http://127.0.0.1:${hub.http.port}`,
    async cleanup(): Promise<void> {
      await hub.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// --- minimal tus core-protocol client (raw HTTP, offline loopback) -----------

function metadataHeader(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([key, value]) => `${key} ${Buffer.from(value, 'utf8').toString('base64')}`)
    .join(',');
}

async function createUpload(
  base: string,
  uploadLength: number,
  metadata: Record<string, string>,
): Promise<string> {
  const res = await fetch(`${base}/upload`, {
    method: 'POST',
    headers: {
      'tus-resumable': '1.0.0',
      'upload-length': String(uploadLength),
      'upload-metadata': metadataHeader(metadata),
    },
  });
  assert.equal(res.status, 201, `creation failed: ${res.status} ${await res.text()}`);
  const location = res.headers.get('location');
  assert.ok(location, 'Location header present');
  return new URL(location, base).toString();
}

async function patchChunk(
  url: string,
  offset: number,
  chunk: Uint8Array,
): Promise<number> {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'tus-resumable': '1.0.0',
      'content-type': 'application/offset+octet-stream',
      'upload-offset': String(offset),
    },
    body: chunk,
  });
  assert.equal(res.status, 204, `PATCH failed: ${res.status} ${await res.text()}`);
  const newOffset = res.headers.get('upload-offset');
  assert.ok(newOffset, 'Upload-Offset in PATCH response');
  return Number.parseInt(newOffset, 10);
}

/** HEAD probe — the resumability entry point for an interrupted upload. */
async function headOffset(url: string): Promise<number> {
  const res = await fetch(url, {
    method: 'HEAD',
    headers: { 'tus-resumable': '1.0.0' },
  });
  assert.equal(res.status, 200, `HEAD failed: ${res.status}`);
  const offset = res.headers.get('upload-offset');
  assert.ok(offset, 'Upload-Offset in HEAD response');
  return Number.parseInt(offset, 10);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 15_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(intervalMs);
  }
  throw new Error('waitFor: predicate not satisfied before timeout');
}

function inboxFiles(h: M4Harness): string[] {
  return existsSync(h.inboxDir) ? readdirSync(h.inboxDir) : [];
}

function recordingId(h: M4Harness): string {
  const row = h.hub.db.sqlite
    .prepare('SELECT id FROM recordings LIMIT 1')
    .get() as { id: string } | undefined;
  return row?.id ?? '';
}

test('M4 tus: full upload → inbox → pipeline → transcript projection, tus store cleaned', async () => {
  const h = await harness();
  try {
    const url = await createUpload(h.base, AUDIO_BYTES.length, {
      filename: 'walk-note.m4a',
      filetype: 'audio/mp4',
    });
    assert.ok(url.startsWith(h.base), 'upload URL points at the hub');

    const offset = await patchChunk(url, 0, AUDIO_BYTES);
    assert.equal(offset, AUDIO_BYTES.length);

    // Completion hand-off: the finalized file is in inbox/, tus store is clean.
    await waitFor(() => inboxFiles(h).length === 1);
    const files = inboxFiles(h);
    assert.ok(files[0].endsWith('.m4a'), `inbox file keeps audio extension: ${files[0]}`);
    const inboxPath = join(h.inboxDir, files[0]);
    assert.deepEqual(readFileSync(inboxPath), AUDIO_BYTES, 'inbox bytes identical to upload');
    assert.deepEqual(readdirSync(h.tusDir), [], 'tus temp store cleaned after finish');

    // Existing pipeline takes over unchanged: mock ASR → final projection.
    await waitFor(
      () => getRecording(h.hub.db.sqlite, recordingId(h))?.status === 'ready',
      15_000,
    );
    const rec = getRecording(h.hub.db.sqlite, recordingId(h));
    assert.ok(rec !== null);
    const final = getCurrentRevision(h.hub.db.sqlite, rec.id, 'final');
    assert.ok(final !== null, 'final revision exists');
    assert.ok(listSegments(h.hub.db.sqlite, final.id).length > 0);

    const projectionPath = join(h.dataDir, 'recordings', rec.id, 'transcript.final.md');
    assert.ok(existsSync(projectionPath), 'transcript.final.md written');
    const sidecar = `${projectionPath}.sha256`;
    const sidecarHash = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0];
    const sha256 = (p: string): string =>
      createHash('sha256').update(readFileSync(p)).digest('hex');
    assert.equal(sidecarHash, sha256(projectionPath), 'sidecar matches projection bytes');
  } finally {
    await h.cleanup();
  }
});

test('M4 tus: interrupted upload resumes via HEAD offset and completes exactly once', async () => {
  const h = await harness();
  try {
    // The fixture is tiny (78 B), so pad it to guarantee >1 chunk.
    const payload = Buffer.concat([AUDIO_BYTES, Buffer.alloc(4096, 0x2a)]);
    const url = await createUpload(h.base, payload.length, {
      filename: 'interrupted.m4a',
      filetype: 'audio/mp4',
    });

    // --- "interrupt": only the first chunk arrives ---------------------------
    const firstChunk = payload.subarray(0, 1024);
    const afterFirst = await patchChunk(url, 0, firstChunk);
    assert.equal(afterFirst, firstChunk.length);

    // Partial file survives server-side; nothing in inbox yet.
    await delay(300);
    assert.deepEqual(inboxFiles(h), [], 'no inbox file while upload is partial');
    assert.ok(readdirSync(h.tusDir).length > 0, 'partial upload persists in tus store');

    // --- resume: HEAD gives the authoritative offset, second chunk continues --
    const resumeOffset = await headOffset(url);
    assert.equal(resumeOffset, firstChunk.length, 'HEAD reports committed offset');

    const secondChunk = payload.subarray(resumeOffset);
    const finalOffset = await patchChunk(url, resumeOffset, secondChunk);
    assert.equal(finalOffset, payload.length, 'upload completed from resume offset');

    // Pipeline takes over: the resumed upload completes exactly once.
    await waitFor(
      () => getRecording(h.hub.db.sqlite, recordingId(h))?.status === 'ready',
      15_000,
    );
    assert.deepEqual(readdirSync(h.tusDir), [], 'tus store cleaned after resumed finish');
    assert.deepEqual(inboxFiles(h), [], 'intake archived the completed upload');

    // Idempotent: exactly one recording, one final revision, one projection,
    // and no leftover duplicates of either job or inbox file.
    assert.equal(countRecordings(h.hub.db.sqlite), 1, 'exactly one recording');
    const rec = getRecording(h.hub.db.sqlite, recordingId(h));
    assert.ok(rec !== null);
    const final = getCurrentRevision(h.hub.db.sqlite, rec.id, 'final');
    assert.ok(final !== null, 'final revision exists');
    assert.ok(listSegments(h.hub.db.sqlite, final.id).length > 0, 'segments exist');
    const archived = rec.audio_path;
    assert.ok(archived !== null && existsSync(archived), 'audio archived');
    assert.deepEqual(readFileSync(archived), payload, 'archived bytes identical to upload');
    assert.ok(archived.endsWith('.m4a'), 'archived with the contract extension');
    assert.equal(
      existsSync(join(h.dataDir, 'recordings', rec.id, 'transcript.final.md')),
      true,
      'projection exists',
    );
    const transcribeJobs = h.hub.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'transcribe'")
      .get() as { n: number };
    assert.equal(transcribeJobs.n, 1, 'exactly one transcribe job');
  } finally {
    await h.cleanup();
  }
});

test('M4 tus: metadata contract enforced — audio accepted, non-audio rejected', async () => {
  const h = await harness();
  try {
    // Contract honored: filename + filetype drive validation and the target ext.
    const url = await createUpload(h.base, AUDIO_BYTES.length, {
      filename: 'note.m4a',
      filetype: 'audio/mp4',
    });
    await patchChunk(url, 0, AUDIO_BYTES);
    await waitFor(
      () => getRecording(h.hub.db.sqlite, recordingId(h))?.status === 'ready',
      15_000,
    );
    assert.equal(countRecordings(h.hub.db.sqlite), 1, 'valid upload became a recording');

    // Non-audio MIME rejected at creation.
    const pdf = await fetch(`${h.base}/upload`, {
      method: 'POST',
      headers: {
        'tus-resumable': '1.0.0',
        'upload-length': '10',
        'upload-metadata': metadataHeader({ filename: 'notes.pdf', filetype: 'application/pdf' }),
      },
    });
    assert.equal(pdf.status, 400, 'non-audio filetype rejected');

    // Non-audio extension rejected even with an audio/* MIME.
    const lying = await fetch(`${h.base}/upload`, {
      method: 'POST',
      headers: {
        'tus-resumable': '1.0.0',
        'upload-length': '10',
        'upload-metadata': metadataHeader({ filename: 'notes.txt', filetype: 'audio/mp4' }),
      },
    });
    assert.equal(lying.status, 400, 'non-audio filename extension rejected');

    // Missing metadata rejected.
    const missing = await fetch(`${h.base}/upload`, {
      method: 'POST',
      headers: {
        'tus-resumable': '1.0.0',
        'upload-length': '10',
        'upload-metadata': metadataHeader({ filename: 'note.m4a' }),
      },
    });
    assert.equal(missing.status, 400, 'missing filetype rejected');

    // Nothing leaked into the consume folder or the tus store by rejections.
    await delay(300);
    assert.deepEqual(readdirSync(h.tusDir), [], 'rejected creations leave no tus temp files');
    assert.equal(countRecordings(h.hub.db.sqlite), 1, 'rejected uploads create no recordings');
    const transcribeJobs = h.hub.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'transcribe'")
      .get() as { n: number };
    assert.equal(transcribeJobs.n, 1, 'rejected uploads enqueue nothing');
  } finally {
    await h.cleanup();
  }
});
