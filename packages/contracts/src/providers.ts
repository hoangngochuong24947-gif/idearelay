/**
 * The seven Provider contracts (spec §7). Signatures are **locked** — copy them
 * verbatim. All calls are async and serializable (ADR-0009): implementations are
 * in-process TS modules registered by name/kind/credential-source/capability.
 */

import type {
  CorpusDoc,
  CredentialSource,
  JsonObject,
  ProviderKind,
  ProviderRegistration,
} from './domain.js';

// ---------------------------------------------------------------------------
// §7.1 ASRProvider (ADR-0007 two-phase)
// ---------------------------------------------------------------------------

export interface AudioChunk {
  seq: number;
  pcm: Uint8Array;
  sampleRate: number;
  channels: number;
}

export interface AudioRef {
  recordingId: string;
  path: string;
  mime: string;
  durationMs?: number | null;
}

export interface StreamOpts {
  languageHints?: string[];
  hotwords?: string[];
}

export interface TranscribeOpts {
  languageHints?: string[];
  hotwords?: string[];
  diarization?: boolean;
}

/** A provisional, in-place-replaceable streaming segment. */
export interface PartialSegment {
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
  isFinal: boolean;
}

export interface TranscriptSegmentResult {
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string | null;
  confidence?: number | null;
}

/** Result of a Final transcription (§7.1). */
export interface TranscriptResult {
  revisionKind: TranscriptRevisionKind;
  providerId: string;
  model: string | null;
  languageHints: string[] | null;
  segments: TranscriptSegmentResult[];
}

// Local alias kept intentionally literal to avoid drifting from §5.1.
type TranscriptRevisionKind = 'provisional' | 'final';

export interface AsrCapabilities {
  streaming: boolean;
  maxSessionDurationMs: number | null; // DashScope 实时有会话上限
  hotwords: boolean;
  diarization: boolean;
  languages: string[];
  revisions: Array<'provisional' | 'final'>;
  resume: boolean; // 断线能否续传（多数为 false）
}

export interface AsrProvider {
  readonly id: string;
  readonly capabilities: AsrCapabilities;

  /** Provisional：流式临时文本，UI 句末原地替换 */
  stream?(
    audio: AsyncIterable<AudioChunk>,
    opts: StreamOpts,
  ): AsyncIterable<PartialSegment>;

  /** Final：整段精转，落成 is_current 的 final revision */
  transcribe(audio: AudioRef, opts: TranscribeOpts): Promise<TranscriptResult>;
}

// ---------------------------------------------------------------------------
// §7.2 ModelProvider
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelInfo {
  id: string;
  contextWindow: number | null;
  structuredOutput: boolean;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormatJsonSchema?: JsonObject | null;
}

export interface CompletionResult {
  text: string;
  model: string;
  usage?: { promptTokens?: number; completionTokens?: number } | null;
}

export interface ModelProvider {
  readonly id: string;
  models(): ModelInfo[]; // 含能力：上下文长度、是否支持结构化输出
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

// ---------------------------------------------------------------------------
// §7.3 DecisionProvider (ADR-0005 three primitives)
// ---------------------------------------------------------------------------

export type Primitive = 'choice' | 'score' | 'noul';

export interface DecisionRequest {
  primitive: Primitive;
  question: string;
  options?: string[]; // choice：≤20 项（Laya 约束）
  scale?: { min: number; max: number; labels?: string[] }; // score
  thresholdOverrides?: {
    // per-call 覆盖默认阈值
    high?: number;
    low?: number;
    noulBand?: [number, number];
  };
}

export interface DecisionResult {
  primitive: Primitive;
  choice?: string;
  probabilities?: Record<string, number>;
  score?: number;
  probability?: number; // noul
  confidence: number; // 校准概率
  certainty: 'high' | 'medium' | 'low';
  abstained: boolean; // 一等结果，不是低置信的同义词
  modelVersion: string;
}

export interface DecisionProvider {
  readonly id: string;
  decide(req: DecisionRequest): Promise<DecisionResult>;
}

// ---------------------------------------------------------------------------
// §7.4 StorageProvider
// ---------------------------------------------------------------------------

export interface BlobRef {
  key: string;
  mime: string;
  size: number;
  checksum: string;
  path?: string | null;
}

export interface StorageProvider {
  readonly id: string;
  readonly capabilities: { vector: boolean; fullText: boolean; airGapped: boolean };
  put(blob: BlobRef): Promise<void>;
  get(key: string): Promise<BlobRef | null>;
}

// ---------------------------------------------------------------------------
// §7.5 SyncProvider (单向镜像, ADR-0002 semantics)
// ---------------------------------------------------------------------------

export interface SyncTarget {
  id: string;
  kind: string;
  config: JsonObject;
}

export interface ProjectedFile {
  path: string;
  checksum: string;
  mime?: string | null;
}

export interface SyncResult {
  pushed: number;
  skipped: number;
  errors: string[];
}

export interface SyncProvider {
  readonly id: string;
  readonly capabilities: { direction: 'push'; ttlDays: number | null };
  push(target: SyncTarget, files: ProjectedFile[]): Promise<SyncResult>;
}

// ---------------------------------------------------------------------------
// §7.6 RagProvider (ADR-0009; stack-survey §6)
// ---------------------------------------------------------------------------

export interface RetrieveOpts {
  topK?: number;
  corpusIds?: string[];
}

export interface RagHit {
  docId: string;
  path: string;
  score: number;
  snippet: string;
}

export interface RagProvider {
  readonly id: string;
  readonly capabilities: { hybrid: boolean; embeddingModel: string | null };
  index(docs: CorpusDoc[]): Promise<void>;
  retrieve(query: string, opts: RetrieveOpts): Promise<RagHit[]>; // BM25 + KNN 融合
}

// ---------------------------------------------------------------------------
// §7.7 ExecutorProvider (ADR-0006)
// ---------------------------------------------------------------------------

export interface ExecutorJob {
  id: string;
  requirementId: string;
  workspacePath: string; // 每 run 独立目录
  toolWhitelist: string[]; // 显式允许的工具/命令
  readAllow: string[]; // 可读的 Corpus 路径白名单
  prompt: string;
  deliverablePath: string;
}

export interface ExecutorHandle {
  id: string;
  providerId: string;
  workspacePath: string;
}

export interface ExecutorStatus {
  stage: string;
  running: boolean;
  done: boolean;
  failed: boolean;
  detail?: string | null;
}

export interface ExecutorProvider {
  readonly id: string;
  readonly capabilities: {
    sandboxed: boolean;
    toolWhitelist: boolean;
    rollback: boolean;
  };
  submit(job: ExecutorJob): Promise<ExecutorHandle>;
  status(h: ExecutorHandle): Promise<ExecutorStatus>; // stage / 是否挂掉
  rollback(h: ExecutorHandle): Promise<void>; // 丢弃工作目录 + 审计外部副作用
}

// ---------------------------------------------------------------------------
// §7 preamble — registry (name / kind / credential-source / capability)
// ---------------------------------------------------------------------------

export interface ProviderRegistry {
  register(reg: ProviderRegistration): void;
  get(id: string): ProviderRegistration | undefined;
  list(kind?: ProviderKind): ProviderRegistration[];
}

export function createProviderRegistry(): ProviderRegistry {
  const byId = new Map<string, ProviderRegistration>();
  return {
    register(reg: ProviderRegistration): void {
      if (byId.has(reg.id)) {
        throw new Error(`provider already registered: ${reg.id}`);
      }
      byId.set(reg.id, reg);
    },
    get(id: string): ProviderRegistration | undefined {
      return byId.get(id);
    },
    list(kind?: ProviderKind): ProviderRegistration[] {
      const all = [...byId.values()];
      return kind === undefined ? all : all.filter((r) => r.kind === kind);
    },
  };
}

/** Convenience constructor for an env-backed credential source (ADR-0009). */
export function envCredential(name: string): CredentialSource {
  return { kind: 'env', name };
}
