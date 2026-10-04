/**
 * First RagProvider (spec §7.6, stack-survey §6): hybrid retrieval over the
 * local SQLite — FTS5 (BM25) + sqlite-vec (KNN) fused with Reciprocal Rank
 * Fusion. Embeddings come from a local `.gguf` via sqlite-lembed; no Python,
 * no network at query time.
 *
 * Provider-owned shadow tables (deterministic names, created at runtime via
 * raw SQL — the shared migration is untouched):
 *
 *   rag_fts_docs   FTS5 virtual table (trigram tokenizer — works for both
 *                  Chinese substrings and English words), a regular FTS5 table
 *                  so rows are deletable for idempotent re-indexing.
 *   rag_doc_meta   metadata per indexed doc (§5.7 semantics: corpus_id, path,
 *                  checksum, mime, indexed_at) + vec_rowid bookkeeping.
 *   rag_vec_docs   vec0 virtual table holding one embedding per doc.
 *   rag_vec_info   provider bookkeeping (embedding dim + model id).
 *
 * Rows are truth (ADR-0002): `index()` is idempotent — a doc whose content
 * checksum is unchanged is skipped entirely, a changed doc is replaced
 * (delete + reinsert in one transaction). Re-running never duplicates rows.
 *
 * Degradation contract: if the extension libraries or the `.gguf` model are
 * unavailable, `capabilities` becomes `{ hybrid: false, embeddingModel: null }`
 * and retrieval falls back to BM25-only. KNN is never half-faked in production
 * code; tests may inject a deterministic embedding via `embeddingOverride`
 * (test-only seam) to exercise the vector + fusion paths offline.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { load as loadVec } from 'sqlite-vec';
import { load as loadLembed } from 'sqlite-lembed';
import type { CorpusDoc, RagHit, RagProvider, RetrieveOpts } from '@idearelay/contracts';
import { reciprocalRankFusion } from './fusion.js';

// ---------------------------------------------------------------------------
// Provenance of the default embedding model
// ---------------------------------------------------------------------------

/**
 * Provenance of the default local embedding model, kept under `data/`
 * (gitignored — models never enter git). Chinese + English, 512-dim, ~25 MB.
 * Base model: BAAI/bge-small-zh-v1.5, Q8_0 quantization by CompendiumLabs.
 */
export const DEFAULT_EMBEDDING_MODEL = {
  file: 'bge-small-zh-v1.5-q8_0.gguf',
  repo: 'https://huggingface.co/CompendiumLabs/bge-small-zh-v1.5-gguf',
  sourceUrl:
    'https://huggingface.co/CompendiumLabs/bge-small-zh-v1.5-gguf/resolve/main/bge-small-zh-v1.5-q8_0.gguf',
  sha256: '5a88d266870fbd27c6f329df60de80e2d4cf3bbd5e6f080bd5c1b2e5abb12039',
  dim: 512,
} as const;

export const SQLITE_HYBRID_RAG_ID = 'sqlite-hybrid';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CreateRagProviderOptions {
  /**
   * Path to the authoritative SQLite database file. The provider opens its own
   * dedicated connection (WAL, `enableLoadExtension: true`) so extension
   * loading stays off the shared hub connection. A file-backed path is
   * required (`:memory:` throws) so hub and tests behave identically.
   */
  dbPath: string;
  /**
   * Path to a local `.gguf` embedding model (loaded via sqlite-lembed).
   * Defaults to `<cwd>/data/models/bge-small-zh-v1.5-q8_0.gguf`. If missing or
   * unloadable the provider degrades cleanly to BM25-only.
   */
  modelPath?: string;
  /** Registry name inside `lembed_models`. Default: `bge-small-zh-v1.5`. */
  modelName?: string;
  /**
   * Only the first N chars of a doc are embedded (bge context is 512 tokens).
   * Default: 2000.
   */
  maxEmbedChars?: number;
  /**
   * **TEST-ONLY seam.** Deterministic embedding function overriding
   * sqlite-lembed, so the vector/fusion paths can be exercised without a
   * model. Never set this from production wiring.
   */
  embeddingOverride?: (text: string) => Buffer;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Internal vector backend state. */
interface VectorState {
  /** Registered lembed model name, or `test-override` for the test seam. */
  modelId: string;
  /** Embedding dimension (floats). */
  dim: number;
  embed(text: string): Buffer | null;
}

interface MetaRow {
  doc_id: string;
  corpus_id: string;
  path: string;
  checksum: string | null;
  mime: string | null;
  indexed_at: number | null;
  vec_rowid: number | null;
}

export function createRagProvider(
  options: CreateRagProviderOptions,
): RagProvider & { close(): void } {
  if (options.dbPath === ':memory:') {
    throw new Error('createRagProvider requires a file-backed dbPath');
  }
  const sqlite = new Database(
    options.dbPath,
    // better-sqlite3 ≥13 supports enableLoadExtension at runtime;
    // @types/better-sqlite3@9.6 predates the option, hence the cast.
    { enableLoadExtension: true } as unknown as Database.Options,
  );
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const maxEmbedChars = options.maxEmbedChars ?? 2000;
  const modelName = options.modelName ?? 'bge-small-zh-v1.5';
  const modelPath = options.modelPath
    ? isAbsolute(options.modelPath)
      ? options.modelPath
      : resolve(options.modelPath)
    : join(process.cwd(), 'data', 'models', DEFAULT_EMBEDDING_MODEL.file);

  // --- always: provider-owned shadow tables (deterministic names) ----------
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS rag_doc_meta (
      doc_id     TEXT PRIMARY KEY,
      corpus_id  TEXT NOT NULL,
      path       TEXT NOT NULL,
      checksum   TEXT,
      mime       TEXT,
      indexed_at INTEGER,
      vec_rowid  INTEGER
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts_docs USING fts5(
      doc_id UNINDEXED,
      corpus_id UNINDEXED,
      content,
      tokenize = 'trigram'
    );
    CREATE TABLE IF NOT EXISTS rag_vec_info (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // --- vector backend: override → lembed → none -----------------------------
  const vector = initVectorBackend(sqlite, options, { modelName, modelPath });

  // Per-connection staging table used to route embedding BLOBs into vec0
  // (vec0 rejects bound-parameter DML on rowid; verified on sqlite-vec 0.1.9).
  if (vector !== null) {
    sqlite.exec('CREATE TEMP TABLE IF NOT EXISTS rag_vec_stage (rid INTEGER PRIMARY KEY, emb BLOB)');
  }

  // --- statements ------------------------------------------------------------
  const stmts = {
    metaByDoc: sqlite.prepare('SELECT * FROM rag_doc_meta WHERE doc_id = ?'),
    insertMeta: sqlite.prepare(`
      INSERT INTO rag_doc_meta (doc_id, corpus_id, path, checksum, mime, indexed_at, vec_rowid)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_id) DO UPDATE SET
        corpus_id = excluded.corpus_id, path = excluded.path, checksum = excluded.checksum,
        mime = excluded.mime, indexed_at = excluded.indexed_at, vec_rowid = excluded.vec_rowid
    `),
    deleteFts: sqlite.prepare('DELETE FROM rag_fts_docs WHERE doc_id = ?'),
    insertFts: sqlite.prepare(
      'INSERT INTO rag_fts_docs (doc_id, corpus_id, content) VALUES (?, ?, ?)',
    ),
    bm25All: sqlite.prepare(`
      SELECT rag_fts_docs.doc_id AS docId,
             snippet(rag_fts_docs, 2, '', '', '…', 24) AS snippet
      FROM rag_fts_docs
      WHERE rag_fts_docs MATCH ?
      ORDER BY bm25(rag_fts_docs)
      LIMIT ?
    `),
    pathByDoc: sqlite.prepare('SELECT path FROM rag_doc_meta WHERE doc_id = ?'),
  };

  // Vector statements exist only when a vector backend is active.
  const vecStmts =
    vector === null
      ? null
      : {
          nextVecRowid: sqlite.prepare(
            'SELECT COALESCE(MAX(rowid), 0) + 1 AS next FROM rag_vec_docs',
          ),
          deleteVec: sqlite.prepare('DELETE FROM rag_vec_docs WHERE rowid = ?'),
          clearStage: sqlite.prepare('DELETE FROM temp.rag_vec_stage'),
          stageVec: sqlite.prepare('INSERT INTO temp.rag_vec_stage (rid, emb) VALUES (?, ?)'),
          insertVecFromStage: sqlite.prepare(
            'INSERT INTO rag_vec_docs(rowid, embedding) SELECT rid, emb FROM temp.rag_vec_stage WHERE rid = ?',
          ),
        };

  // Corpus-filtered BM25 statement, rebuilt per distinct corpus list.
  const bm25FilteredCache = new Map<string, Database.Statement>();
  // KNN statements vary only in pool size (k must be a literal for vec0).
  const knnCache = new Map<number, Database.Statement>();

  const embedText = (text: string): Buffer | null =>
    vector === null ? null : vector.embed(text.slice(0, maxEmbedChars));

  const provider: RagProvider & { close(): void } = {
    id: SQLITE_HYBRID_RAG_ID,

    capabilities: {
      // "hybrid" = BM25 + KNN both available (§7.6).
      hybrid: vector !== null,
      embeddingModel: vector === null ? null : `${vector.modelId}@${vector.dim}d`,
    },

    async index(docs: CorpusDoc[]): Promise<void> {
      for (const doc of docs) {
        indexOne(doc);
      }
    },

    async retrieve(query: string, opts: RetrieveOpts): Promise<RagHit[]> {
      const topK = opts.topK ?? 10;
      if (topK <= 0 || query.trim().length === 0) return [];
      // Candidate pool larger than topK: fusion ranks the union of both lists.
      const pool = Math.max(topK * 4, 20);

      // 1. BM25 (best first). The trigram tokenizer needs terms ≥ 3 chars;
      //    shorter queries contribute no BM25 list to the fusion.
      const bm25Rows = bm25Search(query, opts.corpusIds, pool);

      // 2. KNN (best first), when the embedding backend is available.
      const knnRows = knnSearch(query, opts.corpusIds, pool);

      // 3. RRF fusion over the ranked lists (fusion.ts documents the choice).
      const fused = reciprocalRankFusion(
        [
          { name: 'bm25', ranked: bm25Rows.map((r) => r.docId) },
          { name: 'knn', ranked: knnRows },
        ],
        topK,
      );

      // 4. Materialize RagHits. BM25 rows carry an FTS5 snippet; KNN-only hits
      //    get a plain prefix of the doc content.
      const snippets = new Map(bm25Rows.map((r) => [r.docId, r.snippet] as const));
      const hits: RagHit[] = [];
      for (const f of fused) {
        const meta = stmts.metaByDoc.get(f.docId) as MetaRow | undefined;
        if (!meta) continue;
        let snippet = snippets.get(f.docId);
        if (snippet === undefined || snippet.length === 0) {
          snippet = contentPrefix(meta.path, 160);
        }
        hits.push({ docId: f.docId, path: meta.path, score: f.score, snippet });
      }
      return hits;
    },

    close(): void {
      sqlite.close();
    },
  };

  return provider;

  // --- internals -------------------------------------------------------------

  function indexOne(doc: CorpusDoc): void {
    // Unreadable/binary content: nothing to index; existing rows stay as-is.
    const content = readContentRaw(doc.path);
    if (content === null) return;
    // §5.7 rows-are-truth: the stored checksum is always the checksum of the
    // content actually indexed, never a caller-provided value.
    const checksum = sha256Hex(content);

    const existing = stmts.metaByDoc.get(doc.id) as MetaRow | undefined;
    if (
      existing &&
      existing.checksum === checksum &&
      existing.corpus_id === doc.corpusId &&
      existing.path === doc.path
    ) {
      return; // idempotent re-run: unchanged doc → no-op, no duplicates
    }

    sqlite.transaction(() => {
      // Replace: FTS row + vector row + meta row.
      stmts.deleteFts.run(doc.id);
      if (existing && existing.vec_rowid != null && vecStmts !== null) {
        vecStmts.deleteVec.run(existing.vec_rowid);
      }
      stmts.insertFts.run(doc.id, doc.corpusId, content);

      let vecRowid: number | null = null;
      if (vecStmts !== null) {
        const emb = embedText(content);
        if (emb !== null) {
          const next = (vecStmts.nextVecRowid.get() as { next: number }).next;
          // vec0 rejects bound-parameter DML on rowid via better-sqlite3
          // (verified against sqlite-vec 0.1.9); route through a temp staging
          // table — the pattern upstream's README uses.
          vecStmts.clearStage.run();
          vecStmts.stageVec.run(next, emb);
          vecStmts.insertVecFromStage.run(next);
          vecStmts.clearStage.run();
          vecRowid = next;
        }
      }
      stmts.insertMeta.run(
        doc.id,
        doc.corpusId,
        doc.path,
        checksum,
        doc.mime ?? null,
        Date.now(),
        vecRowid,
      );
    })();
  }

  function bm25Search(
    query: string,
    corpusIds: string[] | undefined,
    limit: number,
  ): Array<{ docId: string; snippet: string }> {
    const match = ftsMatchQuery(query);
    if (match === null) return [];
    if (corpusIds && corpusIds.length > 0) {
      const key = corpusIds.join('\u0000');
      let stmt = bm25FilteredCache.get(key);
      if (stmt === undefined) {
        const placeholders = corpusIds.map(() => '?').join(', ');
        stmt = sqlite.prepare(`
          SELECT rag_fts_docs.doc_id AS docId,
                 snippet(rag_fts_docs, 2, '', '', '…', 24) AS snippet
          FROM rag_fts_docs
          JOIN rag_doc_meta ON rag_doc_meta.doc_id = rag_fts_docs.doc_id
          WHERE rag_fts_docs MATCH ? AND rag_doc_meta.corpus_id IN (${placeholders})
          ORDER BY bm25(rag_fts_docs)
          LIMIT ?
        `);
        bm25FilteredCache.set(key, stmt);
      }
      return stmt.all(match, ...corpusIds, limit) as Array<{
        docId: string;
        snippet: string;
      }>;
    }
    return stmts.bm25All.all(match, limit) as Array<{ docId: string; snippet: string }>;
  }

  function knnSearch(
    query: string,
    corpusIds: string[] | undefined,
    limit: number,
  ): string[] {
    if (vector === null) return [];
    const emb = embedText(query);
    if (emb === null) return [];
    // Fetch a pool then filter corpus membership in JS: vec0's `k` truncates
    // before the join, so a SQL-side corpus filter could under-fill.
    const pool = corpusIds && corpusIds.length > 0 ? limit * 3 : limit;
    let stmt = knnCache.get(pool);
    if (stmt === undefined) {
      stmt = sqlite.prepare(`
        SELECT rag_doc_meta.doc_id AS docId, rag_doc_meta.corpus_id AS corpusId
        FROM rag_vec_docs
        JOIN rag_doc_meta ON rag_doc_meta.vec_rowid = rag_vec_docs.rowid
        WHERE rag_vec_docs.embedding MATCH ? AND k = ${pool}
      `);
      knnCache.set(pool, stmt);
    }
    const rows = stmt.all(emb) as Array<{ docId: string; corpusId: string }>;
    const allowed = corpusIds && corpusIds.length > 0 ? new Set(corpusIds) : null;
    return rows
      .filter((r) => allowed === null || allowed.has(r.corpusId))
      .map((r) => r.docId)
      .slice(0, limit);
  }

  function contentPrefix(path: string, chars: number): string {
    const content = readContentRaw(path);
    if (content === null) return '';
    const flat = content.replace(/\s+/g, ' ').trim();
    return flat.length <= chars ? flat : flat.slice(0, chars) + '…';
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Read a doc file as UTF-8 text; `null` when missing or binary. */
function readContentRaw(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, 'utf8');
    if (content.includes('\0')) return null; // binary — not indexable as text
    return content;
  } catch {
    return null;
  }
}

/**
 * Build an FTS5 MATCH expression for the trigram tokenizer: whitespace-split
 * terms, each ≥ 3 chars, OR-joined, each quoted (inner quotes doubled). A
 * Chinese query stays one term — trigram gives substring semantics; a query
 * with no term ≥ 3 chars yields `null` = "no BM25 list".
 */
export function ftsMatchQuery(query: string): string | null {
  const terms = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/**
 * Initialize the vector backend. Preference order:
 *  1. test-only override (never in production wiring)
 *  2. sqlite-lembed with the local `.gguf` (requires enableLoadExtension)
 *  3. none → BM25-only
 * Ensures `rag_vec_docs` matches the active embedding dim (drops the table and
 * forces re-index on mismatch, e.g. after a model swap).
 */
function initVectorBackend(
  sqlite: SqliteDatabase,
  options: CreateRagProviderOptions,
  cfg: { modelName: string; modelPath: string },
): VectorState | null {
  const ensureVecTable = (dim: number, modelId: string): void => {
    const row = sqlite
      .prepare("SELECT value FROM rag_vec_info WHERE key = 'dim'")
      .get() as { value: string } | undefined;
    if (row && Number(row.value) !== dim) {
      // Model changed → embeddings are incompatible; drop and force re-index.
      sqlite.exec('DROP TABLE IF EXISTS rag_vec_docs');
      sqlite.prepare('UPDATE rag_doc_meta SET vec_rowid = NULL').run();
    }
    sqlite.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS rag_vec_docs USING vec0(embedding float[${dim}])`,
    );
    sqlite
      .prepare(
        `INSERT INTO rag_vec_info (key, value) VALUES ('dim', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(dim));
    sqlite
      .prepare(
        `INSERT INTO rag_vec_info (key, value) VALUES ('model', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(modelId);
  };

  // 1. Test-only deterministic override.
  if (options.embeddingOverride) {
    try {
      loadVec(sqlite);
      const probe = options.embeddingOverride('m6-dim-probe');
      const dim = probe.length / 4;
      if (!Number.isInteger(dim) || dim <= 0) return null;
      ensureVecTable(dim, 'test-override');
      const fn = options.embeddingOverride;
      return { modelId: 'test-override', dim, embed: (text) => fn(text) };
    } catch {
      return null;
    }
  }

  // 2. Real model via sqlite-lembed.
  if (!existsSync(cfg.modelPath)) return null;
  try {
    loadVec(sqlite);
    loadLembed(sqlite);
    const registered = sqlite
      .prepare('SELECT COUNT(*) AS n FROM lembed_models WHERE name = ?')
      .get(cfg.modelName) as { n: number };
    if (registered.n === 0) {
      // The model path pointer must stay inside SQL: lembed_model_from_file
      // returns an opaque sqlite3 pointer that cannot round-trip through JS.
      sqlite
        .prepare('INSERT INTO lembed_models(name, model) SELECT ?, lembed_model_from_file(?)')
        .run(cfg.modelName, cfg.modelPath);
    }
    const stmt = sqlite.prepare('SELECT lembed(?, ?) AS emb');
    const probe = stmt.get(cfg.modelName, 'm6-dim-probe 连通性测试') as {
      emb: Buffer | null;
    };
    if (!probe.emb) return null;
    const dim = probe.emb.length / 4;
    if (!Number.isInteger(dim) || dim <= 0) return null;
    ensureVecTable(dim, cfg.modelName);
    return {
      modelId: cfg.modelName,
      dim,
      embed(text: string): Buffer | null {
        try {
          const row = stmt.get(cfg.modelName, text) as { emb: Buffer | null };
          return row.emb ?? null;
        } catch {
          return null;
        }
      },
    };
  } catch {
    return null;
  }
}
