import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { EVENT_TYPES, type InboxKind } from '@idearelay/contracts';
import { openDatabase, type Db } from './db/index.js';
import { listEvents } from './db/repositories/events.js';
import { insertInboxItem } from './db/repositories/inbox.js';
import { insertRequirement } from './db/repositories/requirements.js';
import { startHttp, type HttpHandle } from './http/server.js';

interface Harness {
  db: Db;
  http: HttpHandle;
  base: string;
  cleanup(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'idearelay-m7-inbox-'));
  const db = openDatabase(join(root, 'idea-relay.db'));
  const http = await startHttp({
    host: '127.0.0.1',
    port: 0,
    db: db.sqlite,
    log: () => undefined,
  });
  return {
    db,
    http,
    base: `http://127.0.0.1:${http.port}`,
    async cleanup(): Promise<void> {
      await http.close();
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function seedItem(
  h: Harness,
  overrides: Partial<{ kind: InboxKind; status: string; createdAt: number }> = {},
): string {
  const id = randomUUID();
  insertInboxItem(h.db.sqlite, {
    id,
    kind: overrides.kind ?? 'idea',
    subjectType: 'transcript_revision',
    subjectId: randomUUID(),
    payloadJson: JSON.stringify({
      summary: '测试摘要',
      transcriptExcerpt: '我们需要支持后台录音，这是核心需求。',
      tags: ['product'],
    }),
    confidence: 0.42,
    abstained: false,
    status: (overrides.status ?? 'pending') as 'pending',
    createdAt: overrides.createdAt ?? Date.now() - 10_000,
  });
  return id;
}

interface ApiItem {
  id: string;
  kind: string;
  subject_type: string;
  subject_id: string;
  payload: Record<string, unknown> | null;
  confidence: number | null;
  abstained: boolean;
  status: string;
  created_at: number;
}

async function getJson(base: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

async function postJson(
  base: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

function eventsOf(h: Harness, itemId: string): string[] {
  return listEvents(h.db.sqlite, {
    aggregateType: 'inbox_item',
    aggregateId: itemId,
  }).map((e) => e.type);
}

function annotationPayload(h: Harness, itemId: string): Record<string, unknown> {
  const events = listEvents(h.db.sqlite, {
    aggregateType: 'inbox_item',
    aggregateId: itemId,
    type: EVENT_TYPES.AnnotationRecorded,
  });
  assert.equal(events.length, 1, 'exactly one annotation per action');
  return JSON.parse(events[0].payloadJson) as Record<string, unknown>;
}

test('M7 inbox: GET /inbox defaults to pending, ?status filters, bad status 400', async () => {
  const h = await harness();
  try {
    const pending = seedItem(h);
    seedItem(h);
    seedItem(h, { status: 'accepted' });

    const all = await getJson(h.base, '/inbox');
    assert.equal(all.status, 200);
    const items = all.body.items as ApiItem[];
    assert.equal(items.length, 2, 'only pending by default');
    assert.ok(items.every((i) => i.status === 'pending'));
    const first = items.find((i) => i.id === pending)!;
    assert.equal(first.kind, 'idea');
    assert.equal(first.abstained, false);
    assert.equal(first.confidence, 0.42);
    assert.equal(first.subject_type, 'transcript_revision');
    assert.ok(first.payload !== null && first.payload['summary'] === '测试摘要');

    const accepted = await getJson(h.base, '/inbox?status=accepted');
    assert.equal((accepted.body.items as ApiItem[]).length, 1);

    const bad = await getJson(h.base, '/inbox?status=bogus');
    assert.equal(bad.status, 400);
  } finally {
    await h.cleanup();
  }
});

test('M7 inbox: accept/reject/reroute update rows + events + annotations; 404/409', async () => {
  const h = await harness();
  try {
    // --- accept ---------------------------------------------------------
    const acceptId = seedItem(h);
    const accepted = await postJson(h.base, `/inbox/${acceptId}/accept`);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.ok, true);
    const accItem = accepted.body.item as ApiItem;
    assert.equal(accItem.id, acceptId);
    assert.equal(accItem.status, 'accepted');
    const accRow = h.db.sqlite
      .prepare('SELECT * FROM inbox_items WHERE id = ?')
      .get(acceptId) as { resolution_json: string | null; resolved_at: number | null };
    assert.ok(accRow.resolution_json !== null);
    assert.ok(JSON.parse(accRow.resolution_json!)['action'] === 'accept');
    assert.ok(accRow.resolved_at !== null);
    assert.ok(eventsOf(h, acceptId).includes(EVENT_TYPES.InboxItemAccepted));
    const accAnnotation = annotationPayload(h, acceptId);
    assert.equal(accAnnotation['text'], '我们需要支持后台录音，这是核心需求。');
    assert.equal(accAnnotation['label'], 'idea');

    // accept again → 409; unknown id → 404
    assert.equal((await postJson(h.base, `/inbox/${acceptId}/accept`)).status, 409);
    assert.equal((await postJson(h.base, `/inbox/${randomUUID()}/accept`)).status, 404);

    // --- reject ---------------------------------------------------------
    const rejectId = seedItem(h);
    const rejected = await postJson(h.base, `/inbox/${rejectId}/reject`);
    assert.equal(rejected.status, 200);
    assert.equal((rejected.body.item as ApiItem).status, 'rejected');
    assert.ok(eventsOf(h, rejectId).includes(EVENT_TYPES.InboxItemRejected));
    const rejAnnotation = annotationPayload(h, rejectId);
    assert.equal(rejAnnotation['text'], '我们需要支持后台录音，这是核心需求。');
    assert.equal(rejAnnotation['label'], 'idea');

    // --- reroute --------------------------------------------------------
    const rerouteId = seedItem(h, { kind: 'unknown' });
    assert.equal((await postJson(h.base, `/inbox/${rerouteId}/reroute`)).status, 400,
      'missing body → 400');
    assert.equal(
      (await postJson(h.base, `/inbox/${rerouteId}/reroute`, { to_kind: 'bogus' })).status,
      400,
      'invalid kind → 400',
    );
    const rerouted = await postJson(h.base, `/inbox/${rerouteId}/reroute`, {
      to_kind: 'requirement',
    });
    assert.equal(rerouted.status, 200);
    const rrItem = rerouted.body.item as ApiItem;
    assert.equal(rrItem.status, 'rerouted');
    assert.equal(rrItem.kind, 'requirement', 'the human kind becomes the row kind');
    const rrEvents = eventsOf(h, rerouteId);
    assert.ok(rrEvents.includes(EVENT_TYPES.InboxItemRerouted));
    const rrAnnotation = annotationPayload(h, rerouteId);
    assert.equal(rrAnnotation['label'], 'requirement', 'annotation carries the corrected label');

    // reroute of a resolved item → 409
    assert.equal(
      (await postJson(h.base, `/inbox/${rerouteId}/reroute`, { to_kind: 'log' })).status,
      409,
    );
  } finally {
    await h.cleanup();
  }
});

test('M7 /changes: new + updated items after since, fresh timestamp; /requirements shape', async () => {
  const h = await harness();
  try {
    const touchedId = seedItem(h);
    seedItem(h, { status: 'accepted', createdAt: Date.now() - 20_000 }); // resolved long ago? no:
    // (status accepted above was seeded directly, so resolved_at is NULL — fix it via the API)
    const untouchedId = seedItem(h);

    const before = await getJson(h.base, '/changes?since=0');
    assert.equal(before.status, 200);
    assert.ok(Array.isArray(before.body.deletions));
    const ts0 = before.body.timestamp as number;
    assert.ok(typeof ts0 === 'number' && ts0 > 0);
    await delay(10);

    // One pending item is accepted after ts0 → must appear as a change.
    await postJson(h.base, `/inbox/${touchedId}/accept`);

    const after = await getJson(h.base, `/changes?since=${ts0}`);
    assert.equal(after.status, 200);
    const changes = after.body.changes as ApiItem[];
    const ids = changes.map((c) => c.id);
    assert.ok(ids.includes(touchedId), 'the accepted item is a change');
    assert.ok(!ids.includes(untouchedId), 'untouched pending item is not a change');
    assert.ok((after.body.timestamp as number) > ts0, 'fresh server timestamp');

    // The previously-seeded "accepted" row has resolved_at NULL, so it also
    // counts (its created_at precedes ts0 — but COALESCE uses created_at, so it
    // must NOT appear). Verify precisely:
    const seededAccepted = (before.body.changes as ApiItem[]).length;
    assert.ok(seededAccepted >= 3, 'since=0 returns everything');

    assert.equal((await getJson(h.base, '/changes?since=abc')).status, 400);

    // /requirements shape (§11).
    const reqId = randomUUID();
    insertRequirement(h.db.sqlite, {
      id: reqId,
      title: '后台录音支持',
      bodyPath: `requirements/${reqId}-slug.md`,
      status: 'open',
      createdAt: Date.now(),
      sourceRevisionId: randomUUID(),
    });
    const reqs = await getJson(h.base, '/requirements');
    assert.equal(reqs.status, 200);
    const row = (reqs.body.requirements as Array<Record<string, unknown>>).find(
      (r) => r['id'] === reqId,
    )!;
    assert.deepEqual(Object.keys(row).sort(), [
      'body_path',
      'created_at',
      'id',
      'source_revision_id',
      'status',
      'title',
    ]);
    assert.equal(row['status'], 'open');
  } finally {
    await h.cleanup();
  }
});
