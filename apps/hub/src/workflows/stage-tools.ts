import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutorJob, ExecutorProvider, ProviderRegistry } from '@idearelay/contracts';
import { EVENT_TYPES, type JsonObject } from '@idearelay/contracts';
import type { SqliteDb } from '../db/types.js';
import { appendEvent } from '../db/repositories/events.js';
import { insertArtifact } from '../db/repositories/workflows.js';
import type { StageContext } from './types.js';

/**
 * Stage tools (§8.1) — the only capabilities a WorkflowRun's stages can use.
 * Parameters are plain JSON Schema (validated by the Pi loop's coercion path);
 * every implementation is deterministic / dry-run (no network, no code exec).
 */
export interface StageTool {
  name: string;
  description: string;
  parameters: JsonObject;
  execute(
    args: Record<string, unknown>,
    ctx: StageContext,
  ): Promise<{ text: string; output?: unknown }>;
}

export interface StageToolDeps {
  registry: ProviderRegistry;
  executor: ExecutorProvider;
  sqlite: SqliteDb;
  /** Compose the Deliverable markdown from everything prior stages produced. */
  renderDeliverable(ctx: StageContext): string;
  /** Registered RagProvider instance, if any (M6 wires the real one in). */
  ragProvider?: { retrieve(query: string, opts: { topK?: number }): Promise<Array<{ docId: string; path: string; score: number; snippet: string }>> } | null;
  now?: () => number;
  log?: (message: string) => void;
}

const GITHUB_SEARCH_CANNED = [
  {
    repo: 'argmaxinc/WhisperKit',
    stars: 4200,
    match: '示例级参考：后台录音 + 单文件 .m4a 的成熟结构',
    license: 'Apache-2.0',
  },
  {
    repo: 'tus/TUSKit',
    stars: 640,
    match: '断点续传上传客户端，可直接复用',
    license: 'MIT',
  },
];

const WEB_SEARCH_CANNED = [
  {
    title: 'Apple docs: AVAudioSession category options for background audio',
    url: 'https://developer.apple.com/documentation/avfaudio/avaudiosession',
    snippet: 'Use the .playAndRecord category with the audio UI background mode.',
  },
];

export function createStageTools(deps: StageToolDeps): Map<string, StageTool> {
  const tools = new Map<string, StageTool>();

  tools.set('github.search', {
    name: 'github.search',
    description: '在 GitHub 上搜索与需求相关的现成开源实现（deterministic dry-run stub）。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词' } },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(args) {
      const query = typeof args.query === 'string' ? args.query : '';
      return {
        text: JSON.stringify({ query, results: GITHUB_SEARCH_CANNED }),
        output: { query, results: GITHUB_SEARCH_CANNED },
      };
    },
  });

  tools.set('web.search', {
    name: 'web.search',
    description: '网络检索补充资料（deterministic dry-run stub）。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(args) {
      const query = typeof args.query === 'string' ? args.query : '';
      return {
        text: JSON.stringify({ query, results: WEB_SEARCH_CANNED }),
        output: { query, results: WEB_SEARCH_CANNED },
      };
    },
  });

  tools.set('rag.retrieve', {
    name: 'rag.retrieve',
    description: '从 Corpus 混合检索（BM25 + KNN）相关背景片段。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, topK: { type: 'number' } },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const query = typeof args.query === 'string' ? args.query : ctx.requirement.title;
      const topK = typeof args.topK === 'number' ? args.topK : 5;
      const provider = deps.ragProvider ?? null;
      if (provider === null) {
        const registered = deps.registry.list('rag').length > 0;
        const note = registered
          ? 'a RagProvider is registered but no instance is wired yet (M6)'
          : 'no RagProvider registered yet (M6 in progress)';
        const output = { query, hits: [], note };
        return { text: JSON.stringify(output), output };
      }
      const hits = await provider.retrieve(query, { topK });
      return { text: JSON.stringify({ query, hits }), output: { query, hits } };
    },
  });

  tools.set('projection.writeDeliverable', {
    name: 'projection.writeDeliverable',
    description: '把 run 的 Deliverable 写入 run 工作目录，登记 artifacts 行与 projection.written 事件。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute(_args, ctx) {
      const deliverablePath = join(ctx.workspacePath, 'deliverable.md');
      const job: ExecutorJob = {
        id: `exec-${ctx.runId}`,
        requirementId: ctx.requirement.id,
        workspacePath: ctx.workspacePath,
        toolWhitelist: [...ctx.grant.toolWhitelist],
        readAllow: [...ctx.grant.readAllow],
        // The composed Deliverable travels as the job prompt: the dry-run
        // executor "renders" it at deliverablePath (no code execution).
        prompt: deps.renderDeliverable(ctx),
        deliverablePath,
      };
      // Dry-run executor: submit persists the ExecutorJob file and (per ADR-0006
      // pull model) the simulated executor drops the Deliverable at deliverablePath.
      await deps.executor.submit(job);
      const sha256 = createHash('sha256').update(readFileSync(deliverablePath)).digest('hex');

      const createdAt = deps.now?.() ?? Date.now();
      insertArtifact(deps.sqlite, {
        runId: ctx.runId,
        kind: 'deliverable',
        path: deliverablePath,
        checksum: sha256,
        createdAt,
      });
      appendEvent(deps.sqlite, {
        aggregateType: 'workflow_run',
        aggregateId: ctx.runId,
        type: EVENT_TYPES.ProjectionWritten,
        payload: { kind: 'deliverable', path: deliverablePath, sha256 },
        createdAt,
      });
      ctx.deliverablePath = deliverablePath;
      deps.log?.(`write: deliverable at ${deliverablePath}`);
      const output = { deliverablePath, sha256 };
      return { text: JSON.stringify(output), output };
    },
  });

  return tools;
}

/** Render the Deliverable from prior-stage outputs (deterministic). */
export function renderDeliverable(ctx: StageContext): string {
  const lines: string[] = [];
  lines.push(`# Deliverable: ${ctx.requirement.title}`);
  lines.push('');
  lines.push(`- run: ${ctx.runId}`);
  lines.push(`- requirement: ${ctx.requirement.id}`);
  lines.push('');
  lines.push('## 需求');
  lines.push(ctx.requirement.body);
  lines.push('');
  lines.push('## 检索背景 (rag.retrieve)');
  if (ctx.ragHits.length === 0) {
    lines.push('> 无（Corpus 为空或未接 RAG Provider，dry-run 返回空结果）。');
  } else {
    for (const hit of ctx.ragHits) {
      lines.push(`- [${hit.score.toFixed(3)}] ${hit.path}: ${hit.snippet}`);
    }
  }
  lines.push('');
  lines.push('## 开源调研 (scan-oss)');
  lines.push(ctx.scanOssText ?? '> 本阶段无输出。');
  lines.push('');
  lines.push('## PRD 草稿 (enrich / to-prd)');
  lines.push(ctx.enrichText ?? '> 本阶段无输出。');
  lines.push('');
  return lines.join('\n');
}
