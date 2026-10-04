/**
 * WorkflowSpec / WorkflowRun / Stage shapes (spec §5.4, §8.1, ADR-0006).
 * `WorkflowDefinition` is what `workflow_specs.definition_json` carries.
 */

export type StageKind = 'tool' | 'agent';

export interface ToolStageDef {
  name: string;
  kind: 'tool';
  /** The stage tool to execute, e.g. `rag.retrieve` / `projection.writeDeliverable`. */
  tool: string;
}

export interface AgentStageDef {
  name: string;
  kind: 'agent';
  /** Tools the agent may call in this stage — the per-stage whitelist (§8.1). */
  tools: string[];
  /** Key into `definition.promptTemplates`. */
  promptTemplate: string;
}

export type StageDef = ToolStageDef | AgentStageDef;

/** Gate config (§9): a spec only auto-runs for content clearing these. */
export interface GateConfig {
  autoRunWhen: { confidence_min: number; abstained: boolean };
}

/** An embedded prompt template (minimal form; phone edits text only, §8.1). */
export interface PromptTemplate {
  system: string;
  /** Supports a single `{{requirement}}` placeholder. */
  userTemplate: string;
}

export interface WorkflowDefinition {
  name: string;
  stages: StageDef[];
  gate: GateConfig;
  promptTemplates: Record<string, PromptTemplate>;
}

/** Run-level authorization (ADR-0006): whitelist + read-allow, no credentials. */
export interface RunGrant {
  toolWhitelist: string[];
  readAllow: string[];
  /** Credentials never enter the agent; the host proxies every call. */
  credentials: 'none';
  executor: 'dry-run';
}

/** Persisted inside `run_stages.detail_json` (also the heartbeat carrier). */
export interface StageDetail {
  /** Epoch ms of the last liveness sign — the §6 heartbeat. */
  heartbeatAt: number;
  toolCalls: Array<{
    tool: string;
    args: unknown;
    isError: boolean;
    /** Text the tool returned (or the error text when isError). */
    resultText?: string;
  }>;
  /** Stage result payload (rag hits, agent text, deliverable path…). */
  output?: unknown;
  error?: string;
}

/** Context handed to each stage and rebuilt from rows on resume. */
export interface StageContext {
  runId: string;
  workspacePath: string;
  requirement: { id: string; title: string; body: string; bodyPath: string | null };
  grant: RunGrant;
  ragHits: Array<{ docId: string; path: string; score: number; snippet: string }>;
  scanOssText?: string;
  enrichText?: string;
  deliverablePath?: string;
}
