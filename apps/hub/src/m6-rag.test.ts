/**
 * M6 RAG provider tests (spec §7.6, §17-M6).
 *
 * Covers: (a) BM25 (FTS5 trigram) retrieval over zh+en docs, (b) the real
 * local `.gguf` embedding path via sqlite-lembed + sqlite-vec with hybrid
 * fusion — skipped when the model file is absent — plus the same vector path
 * exercised offline through the test-only `embeddingOverride` seam, (c)
 * `corpusIds` isolation, (d) idempotent re-indexing, and the RRF fusion math.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { CorpusDoc } from '@idearelay/contracts';
import {
  createRagProvider,
  ftsMatchQuery,
  ragProviderRegistration,
  reciprocalRankFusion,
  RRF_K,
  type RankedList,
} from './providers/rag/index.js';

const MODEL_PATH = fileURLToPath(
  new URL('../../../data/models/bge-small-zh-v1.5-q8_0.gguf', import.meta.url),
);
const MODEL_AVAILABLE = existsSync(MODEL_PATH);

// ---------------------------------------------------------------------------
// Fixture corpus (zh + en)
// ---------------------------------------------------------------------------

const DOCS: Array<CorpusDoc & { content: string }> = [
  {
    id: 'doc-recording',
    corpusId: 'c1',
    path: '',
    checksum: null,
    mime: 'text/markdown',
    indexedAt: null,
    content:
      '# 后台录音 spike\niOS 的 Background modes 允许免费签名开启后台录音。' +
      '40 分钟实测需要留意音频会话中断的情况。',
  },
  {
    id: 'doc-upload',
    corpusId: 'c1',
    path: '',
    checksum: null,
    mime: 'text/markdown',
    indexedAt: null,
    content:
      '# TUS 上传\niPhone 端用 TUS 协议做断点续传上传，kill-resume 场景验证通过。',
  },
  {
    id: 'doc-walk',
    corpusId: 'c1',
    path: '',
    checksum: null,
    mime: 'text/markdown',
    indexedAt: null,
    content: '# 散步日志\n今天天气不错，去公园散步，顺便用语音记录了一些想法。',
  },
  {
    id: 'doc-db',
    corpusId: 'c2',
    path: '',
    checksum: null,
    mime: 'text/markdown',
    indexedAt: null,
    content: '# 数据库调优\nSQLite 的 WAL 模式与迁移策略笔记，better-sqlite3 同步写入。',
  },
  {
    id: 'doc-workflow',
    corpusId: 'c2',
    path: '',
    checksum: null,
    mime: 'text/markdown',
    indexedAt: null,
    content:
      '# Requirement workflow\nA requirement triggers a workflow: RAG context, ' +
      'open-source survey, then a deliverable document.',
  },
];

interface Harness {
  root: string;
  dbPath: string;
  cleanup(): void;
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'idearelay-m6-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  return {
    root,
    dbPath: join(root, 'idea-relay.db'),
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Materialize fixture docs onto disk with deterministic paths. */
function materialize(h: Harness): CorpusDoc[] {
  return DOCS.map((doc) => {
    const path = join(h.root, 'docs', `${doc.id}.md`);
    writeFileSync(path, doc.content, 'utf8');
    const { content: _content, ...rest } = doc;
    return { ...rest, path };
  });
}

/**
 * Deterministic test-only embedding: hashed character-trigram bag, L2
 * normalized, 64 dims. Overlapping trigrams → cosine proximity, so the vector
 * path behaves sensibly without a model. NEVER used in production code.
 */
function hashEmbed(text: string): Buffer {
  const v = new Float32Array(64);
  const s = text.toLowerCase();
  for (let i = 0; i + 3 <= s.length; i++) {
    const digest = createHash('md5').update(s.slice(i, i + 3), 'utf8').digest();
    const idx = ((digest[0] << 8) | digest[1]) % 64;
    v[idx] += digest[2] & 1 ? 1 : -1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < v.length; i++) v[i] /= norm;
  }
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

// ---------------------------------------------------------------------------
// Pure fusion math
// ---------------------------------------------------------------------------

test('RRF: doc ranked by both lists outranks single-list docs', () => {
  const lists: RankedList[] = [
    { name: 'bm25', ranked: ['a', 'b', 'c'] },
    { name: 'knn', ranked: ['b', 'a', 'd'] },
  ];
  const fused = reciprocalRankFusion(lists, 10);
  // a: 1/61 + 1/62 ; b: 1/62 + 1/61 — tie at the top; both beat c (1/63)
  // and d (1/63), which each appear in only one list.
  const scores = new Map(fused.map((f) => [f.docId, f.score]));
  assert.ok(scores.get('a')! > scores.get('c')!);
  assert.ok(scores.get('b')! > scores.get('d')!);
  assert.ok(Math.abs(scores.get('a')! - scores.get('b')!) < 1e-12);
});

test('RRF: single list degenerates to that list’s order', () => {
  const fused = reciprocalRankFusion([{ name: 'bm25', ranked: ['x', 'y', 'z'] }], 3);
  assert.deepEqual(fused.map((f) => f.docId), ['x', 'y', 'z']);
});

test('RRF: topK truncates and duplicates inside a list are ignored', () => {
  const fused = reciprocalRankFusion(
    [{ name: 'bm25', ranked: ['a', 'a', 'b', 'c'] }, { name: 'knn', ranked: ['b'] }],
    2,
  );
  // b: 1/62 + 1/61 (two lists) > a: 1/61 (one list; its duplicate is ignored)
  assert.equal(fused.length, 2);
  assert.equal(fused[0].docId, 'b');
  assert.equal(fused[1].docId, 'a');
});

// ---------------------------------------------------------------------------
// MATCH expression
// ---------------------------------------------------------------------------

test('ftsMatchQuery: quotes terms, OR-joins, drops sub-trigram terms', () => {
  assert.equal(ftsMatchQuery('后台录音 spike'), '"后台录音" OR "spike"');
  // 2-char Chinese words cannot satisfy the trigram tokenizer (needs ≥ 3
  // chars), so they are dropped like any other short term.
  assert.equal(ftsMatchQuery('需求 拆分'), null);
  assert.equal(ftsMatchQuery('ab cd ef'), null); // every term < 3 chars
  assert.equal(ftsMatchQuery('   '), null);
});

// ---------------------------------------------------------------------------
// Provider against a real file-backed SQLite
// ---------------------------------------------------------------------------

test('BM25 retrieval ranks the obviously relevant doc first (zh + en)', async () => {
  const h = harness();
  try {
    const rag = createRagProvider({ dbPath: h.dbPath, modelPath: '/nonexistent.gguf' });
    assert.equal(rag.capabilities.hybrid, false);
    assert.equal(rag.capabilities.embeddingModel, null);

    await rag.index(materialize(h));

    const zh = await rag.retrieve('后台录音 spike', { topK: 3 });
    assert.ok(zh.length > 0);
    assert.equal(zh[0].docId, 'doc-recording');
    assert.ok(zh[0].snippet.includes('后台录音'));

    const en = await rag.retrieve('requirement workflow deliverable', { topK: 3 });
    assert.equal(en[0].docId, 'doc-workflow');

    // short query (< 3 chars per term) → no BM25 list → no hits, no crash
    assert.deepEqual(await rag.retrieve('a b', { topK: 3 }), []);
    rag.close();
  } finally {
    h.cleanup();
  }
});

test('retrieve on an empty index returns no hits', async () => {
  const h = harness();
  try {
    const rag = createRagProvider({ dbPath: h.dbPath, modelPath: '/nonexistent.gguf' });
    assert.deepEqual(await rag.retrieve('后台录音', {}), []);
    rag.close();
  } finally {
    h.cleanup();
  }
});

test('corpusIds isolation: hits never cross corpus boundaries', async () => {
  const h = harness();
  try {
    const rag = createRagProvider({ dbPath: h.dbPath, modelPath: '/nonexistent.gguf' });
    await rag.index(materialize(h));

    const c1hits = await rag.retrieve('后台录音 spike', { topK: 10, corpusIds: ['c1'] });
    assert.ok(c1hits.length > 0);
    for (const hit of c1hits) {
      assert.equal(DOCS.find((d) => d.id === hit.docId)?.corpusId, 'c1');
    }

    const c2hits = await rag.retrieve('requirement workflow', { topK: 10, corpusIds: ['c2'] });
    assert.ok(c2hits.length > 0);
    for (const hit of c2hits) {
      assert.equal(DOCS.find((d) => d.id === hit.docId)?.corpusId, 'c2');
    }

    // the same queries scoped to the *other* corpus return nothing at all
    assert.deepEqual(await rag.retrieve('后台录音 spike', { corpusIds: ['c2'] }), []);
    assert.deepEqual(await rag.retrieve('requirement workflow', { corpusIds: ['c1'] }), []);
    assert.deepEqual(await rag.retrieve('后台录音', { corpusIds: ['nope'] }), []);
    rag.close();
  } finally {
    h.cleanup();
  }
});

test('re-indexing identical docs is idempotent; changed content updates in place', async () => {
  const h = harness();
  try {
    const rag = createRagProvider({ dbPath: h.dbPath, modelPath: '/nonexistent.gguf' });
    const docs = materialize(h);
    await rag.index(docs);

    const countRows = (): { fts: number; meta: number } => {
      const db = new Database(h.dbPath, { readonly: true });
      try {
        return {
          fts: (db.prepare('SELECT COUNT(*) AS n FROM rag_fts_docs').get() as { n: number }).n,
          meta: (db.prepare('SELECT COUNT(*) AS n FROM rag_doc_meta').get() as { n: number }).n,
        };
      } finally {
        db.close();
      }
    };

    const afterFirst = countRows();
    assert.equal(afterFirst.fts, DOCS.length);
    assert.equal(afterFirst.meta, DOCS.length);

    // identical re-run → no duplicates
    await rag.index(docs);
    assert.deepEqual(countRows(), afterFirst);

    // changed content → replaced in place, still no duplicates
    docs[0] = { ...docs[0], mime: 'text/plain' };
    writeFileSync(join(h.root, 'docs', 'doc-recording.md'), '# 后台录音 spike v2\n补充了中断恢复的结论。', 'utf8');
    await rag.index(docs);
    assert.deepEqual(countRows(), afterFirst);

    const db = new Database(h.dbPath, { readonly: true });
    try {
      const row = db
        .prepare(
          "SELECT checksum, mime, indexed_at, path FROM rag_doc_meta WHERE doc_id = 'doc-recording'",
        )
        .get() as { checksum: string; mime: string; indexed_at: number; path: string };
      const expected = createHash('sha256')
        .update(readFileSync(join(h.root, 'docs', 'doc-recording.md'), 'utf8'), 'utf8')
        .digest('hex');
      assert.equal(row.checksum, expected); // checksum of the indexed content
      assert.equal(row.mime, 'text/plain');
      assert.ok(row.indexed_at > 0);
      assert.equal(row.path, join(h.root, 'docs', 'doc-recording.md'));
    } finally {
      db.close();
    }
    rag.close();
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Vector + fusion via the test-only embedding override (offline)
// ---------------------------------------------------------------------------

test('test-override vector path: KNN + hybrid fusion without a model', async () => {
  const h = harness();
  try {
    const rag = createRagProvider({
      dbPath: h.dbPath,
      modelPath: '/nonexistent.gguf',
      embeddingOverride: hashEmbed,
    });
    assert.equal(rag.capabilities.hybrid, true);
    assert.equal(rag.capabilities.embeddingModel, 'test-override@64d');

    await rag.index(materialize(h));

    // The query shares trigrams with exactly one doc; BM25 and KNN agree, so
    // the fused top hit is that doc with a two-list RRF score.
    const hits = await rag.retrieve('TUS 断点续传 上传', { topK: 5 });
    assert.ok(hits.length > 0);
    assert.equal(hits[0].docId, 'doc-upload');
    // two-list RRF score: present in both lists within rank 2
    assert.ok(hits[0].score >= 2 / (RRF_K + 2) - 1e-9);
    assert.ok(hits[0].snippet.length > 0);

    // corpus isolation also holds on the fused path
    const isolated = await rag.retrieve('TUS 断点续传', { topK: 5, corpusIds: ['c2'] });
    assert.ok(!isolated.some((hit) => hit.docId === 'doc-upload'));
    rag.close();
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Real local .gguf via sqlite-lembed (skipped when the model file is absent)
// ---------------------------------------------------------------------------

test(
  'real .gguf: capabilities declare hybrid and fused retrieval works',
  { skip: !MODEL_AVAILABLE },
  async () => {
    const h = harness();
    try {
      // Explicit modelPath: tests run from apps/hub, while the model lives in
      // the repo-root data/ dir (the hub wiring passes config.dataDir).
      const rag = createRagProvider({ dbPath: h.dbPath, modelPath: MODEL_PATH });
      assert.equal(rag.capabilities.hybrid, true);
      assert.equal(rag.capabilities.embeddingModel, 'bge-small-zh-v1.5@512d');

      const docs = materialize(h);
      await rag.index(docs);

      // Both lists agree on this one → fused top-1.
      const hits = await rag.retrieve('断点续传 上传 iPhone', { topK: 5 });
      assert.ok(hits.length > 0);
      assert.equal(hits[0].docId, 'doc-upload');

      // Vector path participates even without 3+ char lexical overlap: an
      // English paraphrase should surface the workflow doc via KNN.
      const semantic = await rag.retrieve('feature request pipeline research report', {
        topK: 5,
        corpusIds: ['c2'],
      });
      assert.ok(
        semantic.some((hit) => hit.docId === 'doc-workflow'),
        'KNN should surface the workflow doc for an English paraphrase',
      );

      // Registration metadata (ADR-0009) derived from capabilities.
      const reg = ragProviderRegistration(rag);
      assert.equal(reg.kind, 'rag');
      assert.deepEqual(reg.credentialSource, { kind: 'none' });
      assert.equal(reg.capabilities.hybrid, true);
      rag.close();
    } finally {
      h.cleanup();
    }
  },
);
