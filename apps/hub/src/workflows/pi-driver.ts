import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import type { ModelProvider } from '@idearelay/contracts';

/**
 * Pi driver (spec §8.2). Drives agent stages with the **real** in-process Pi
 * `Agent` from `@earendil-works/pi-agent-core@0.80.7`:
 *
 *   new Agent({ initialState: { systemPrompt, model, tools, messages } })
 *   agent.subscribe(e => mapToStage(e))
 *   await agent.prompt(...)
 *
 * The model is supplied through `AgentOptions.streamFn` (Pi's documented
 * injection point, `StreamFn`). Offline (tests + dry-run) a **scripted
 * streamFn** plays the model: it emits real Pi events
 * (`agent_start` / `turn_start` / `tool_execution_start/end` / `agent_end`)
 * through the unmodified Agent pipeline. Production wires a `ModelProvider`
 * adapter instead — see `modelProviderStreamFn`.
 *
 * Pi has **no dedicated error event** (ADR-0003): stage failure is derived from
 * `tool_execution_end.isError` or `Agent.state.errorMessage` (stream error
 * turn). Heartbeat staleness is handled by the runner / recovery scan.
 */

// ---------------------------------------------------------------------------
// Mock Pi model — a plain Model object; only ever handed to our own streamFn.
// ---------------------------------------------------------------------------

/** Minimal pi-ai `Model<any>`-shaped object (never sent anywhere). */
export const MOCK_PI_MODEL = {
  id: 'idearelay-dry-run',
  name: 'idearelay dry-run model',
  api: 'openai-completions',
  provider: 'idearelay',
  baseUrl: 'http://127.0.0.1:0',
  reasoning: false,
  input: ['text' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

// ---------------------------------------------------------------------------
// Scripted streamFn (the offline "mock model")
// ---------------------------------------------------------------------------

/** One scripted assistant turn: either tool calls or a final text answer. */
export type ScriptedTurn =
  | { toolCalls: Array<{ name: string; args: Record<string, unknown> }> }
  | { text: string };

interface AssistantMessageLike {
  role: 'assistant';
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
  >;
  api: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: 'stop' | 'toolUse';
  timestamp: number;
}

/**
 * Minimal `AssistantMessageEventStream`-compatible response: the agent loop
 * only consumes it as `AsyncIterable<AssistantMessageEvent>` + `result()`.
 * Typed loosely here and cast at the `StreamFn` boundary.
 */
class ScriptedResponse {
  constructor(
    private readonly events: unknown[],
    private readonly finalMessage: AssistantMessageLike,
  ) {}

  async *iteration(): AsyncGenerator<unknown> {
    for (const event of this.events) yield event;
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.iteration()[Symbol.asyncIterator]();
  }

  result(): Promise<AssistantMessageLike> {
    return Promise.resolve(this.finalMessage);
  }
}

/**
 * Build a scripted `StreamFn`: each model call pops the next turn from
 * `turns` (the last one repeats). Emits the standard event protocol
 * (`start` → deltas → `done`).
 */
export function createScriptedStreamFn(turns: readonly ScriptedTurn[]): StreamFn {
  let call = 0;
  return (_model, _context) => {
    const turn = turns[Math.min(call, turns.length - 1)];
    call += 1;
    const timestamp = Date.now();
    const content: AssistantMessageLike['content'] = [];
    if ('text' in turn) {
      content.push({ type: 'text', text: turn.text });
    } else {
      turn.toolCalls.forEach((tc, i) => {
        content.push({
          type: 'toolCall',
          id: `call_${call}_${i}`,
          name: tc.name,
          arguments: tc.args,
        });
      });
    }
    const base: AssistantMessageLike = {
      role: 'assistant',
      content: [],
      api: MOCK_PI_MODEL.api,
      provider: MOCK_PI_MODEL.provider,
      model: MOCK_PI_MODEL.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp,
    };
    const events: unknown[] = [{ type: 'start', partial: { ...base } }];
    let index = 0;
    for (const block of content) {
      if (block.type === 'text') {
        events.push({ type: 'text_start', contentIndex: index, partial: { ...base, content: [block] } });
        events.push({
          type: 'text_delta',
          contentIndex: index,
          delta: block.text,
          partial: { ...base, content: [block] },
        });
        events.push({ type: 'text_end', contentIndex: index, content: block.text, partial: { ...base, content: [block] } });
      } else {
        events.push({ type: 'toolcall_start', contentIndex: index, partial: { ...base, content: [block] } });
        events.push({ type: 'toolcall_end', toolCall: block, partial: { ...base, content: [block] } });
      }
      index += 1;
    }
    const final: AssistantMessageLike = { ...base, content, stopReason: 'toolCalls' in turn ? 'toolUse' : 'stop' };
    events.push({
      type: 'done',
      reason: final.stopReason,
      message: final,
    });
    return new ScriptedResponse(events, final) as unknown as ReturnType<StreamFn>;
  };
}

/**
 * Default dry-run behaviour for agent stages: call the stage's first
 * whitelisted tool once, then answer with a deterministic summary. This keeps
 * a zero-config Hub fully offline while exercising the real tool pipeline.
 */
export function createDryRunStreamFn(stageToolName: string): StreamFn {
  return createScriptedStreamFn([
    { toolCalls: [{ name: stageToolName, args: { query: 'dry-run' } }] },
    { text: `dry-run：已通过 ${stageToolName} 完成阶段调研。` },
  ]);
}

// ---------------------------------------------------------------------------
// Production streamFn adapter: ModelProvider → StreamFn
// ---------------------------------------------------------------------------

/**
 * Wire a real model: adapt the Hub's `ModelProvider` (§7.2) to Pi's `StreamFn`.
 * Not exercised offline (no network in tests/dry-run) — this is the one seam a
 * real deployment swaps in.
 */
export function modelProviderStreamFn(
  model: ModelProvider,
  modelName: string,
): StreamFn {
  return async (_piModel, context) => {
    const messages = context.messages.map((m) => {
      if (m.role === 'user') return { role: 'user' as const, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
      if (m.role === 'assistant') {
        return {
          role: 'assistant' as const,
          content: m.content
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map((c) => c.text)
            .join('\n'),
        };
      }
      return {
        role: 'user' as const,
        content: `[tool result] ${m.toolName}: ${m.content.map((c) => (c.type === 'text' ? c.text : '')).join('')}`,
      };
    });
    const completion = await model.complete({
      model: modelName,
      messages: [{ role: 'system', content: context.systemPrompt ?? '' }, ...messages],
    });
    return createScriptedStreamFn([{ text: completion.text }])(MOCK_PI_MODEL, context);
  };
}

// ---------------------------------------------------------------------------
// runAgentStage — Agent + subscribe → stage mapping (§8.2)
// ---------------------------------------------------------------------------

export interface AgentStageResult {
  finalText: string;
  toolCalls: Array<{ tool: string; args: unknown; isError: boolean; resultText?: string }>;
  errorMessage?: string;
}

export interface RunAgentStageOptions {
  systemPrompt: string;
  prompt: string;
  tools: AgentTool[];
  streamFn: StreamFn;
  sessionId?: string;
  /** Observe every raw Pi event (the stage→event mapping seam). */
  onEvent?: (event: AgentEvent) => void;
  /** Called on every event; return epoch ms to bump the heartbeat. */
  onHeartbeat?: (event: AgentEvent) => void;
}

/** Pull the text out of a tool result / error tool result. */
function extractText(result: unknown): string | undefined {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((c): c is { type: 'text'; text: string } => (c as { type?: string }).type === 'text')
    .map((c) => c.text)
    .join('\n');
  return text === '' ? undefined : text;
}

export async function runAgentStage(opts: RunAgentStageOptions): Promise<AgentStageResult> {
  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt,
      model: MOCK_PI_MODEL,
      tools: opts.tools,
      messages: [],
    },
    streamFn: opts.streamFn as never,
    sessionId: opts.sessionId,
    toolExecution: 'sequential',
  });

  const toolCalls: AgentStageResult['toolCalls'] = [];
  const argsByCallId = new Map<string, unknown>();
  agent.subscribe((event) => {
    opts.onEvent?.(event);
    opts.onHeartbeat?.(event);
    if (event.type === 'tool_execution_start') {
      argsByCallId.set(event.toolCallId, event.args);
    } else if (event.type === 'tool_execution_end') {
      // Pi's only failure signal (ADR-0003): isError on tool end.
      const resultText = extractText(event.result);
      toolCalls.push({
        tool: event.toolName,
        args: argsByCallId.get(event.toolCallId) ?? null,
        isError: event.isError,
        resultText,
      });
    }
  });

  await agent.prompt(opts.prompt);
  await agent.waitForIdle();

  const errorMessage = agent.state.errorMessage;
  let finalText = '';
  for (let i = agent.state.messages.length - 1; i >= 0; i -= 1) {
    const message: unknown = agent.state.messages[i];
    if (
      typeof message === 'object' &&
      message !== null &&
      (message as { role?: string }).role === 'assistant'
    ) {
      const content = (message as { content: Array<{ type: string; text?: string }> }).content;
      finalText = content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n');
      break;
    }
  }

  return { finalText, toolCalls, errorMessage };
}
