import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ModelInfo,
  ModelProvider,
} from '@idearelay/contracts';

export const OPENAI_MODEL_ID = 'openai';

export interface OpenAiModelOptions {
  /**
   * API root, e.g. `https://api.openai.com/v1` or a local
   * `http://127.0.0.1:8000/v1`. `chat/completions` is appended.
   */
  baseUrl: string;
  /** Model name sent to the endpoint, e.g. `gpt-4o-mini`. */
  model: string;
  /** Bearer token (credentials read from env by the caller, never persisted). */
  apiKey?: string | null;
  contextWindow?: number | null;
  structuredOutput?: boolean;
  /** Request timeout in ms. Defaults to 60_000. */
  timeoutMs?: number;
}

/**
 * OpenAI-compatible HTTP `ModelProvider` (spec §7.2 / ADR-0009). Works against
 * OpenAI itself or any self-hosted OpenAI-compatible endpoint (remote or local),
 * so summarization never hard-codes a vendor.
 */
export function createOpenAiModelProvider(opts: OpenAiModelOptions): ModelProvider {
  const endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return {
    id: OPENAI_MODEL_ID,
    models(): ModelInfo[] {
      return [
        {
          id: opts.model,
          contextWindow: opts.contextWindow ?? null,
          structuredOutput: opts.structuredOutput ?? false,
        },
      ];
    },
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const body: Record<string, unknown> = {
        model: req.model !== '' ? req.model : opts.model,
        messages: req.messages.map(toWireMessage),
      };
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
      if (req.responseFormatJsonSchema != null) {
        body.response_format = req.responseFormatJsonSchema;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(opts.apiKey != null && opts.apiKey.length > 0
              ? { authorization: `Bearer ${opts.apiKey}` }
              : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(
          `model request failed: ${response.status} ${response.statusText} ${detail}`.trim(),
        );
      }

      const json: unknown = await response.json();
      return parseChatCompletion(json, body.model as string);
    },
  };
}

function toWireMessage(message: ChatMessage): { role: string; content: string } {
  return { role: message.role, content: message.content };
}

interface ChatCompletionShape {
  choices?: Array<{ message?: { content?: unknown } }>;
  model?: unknown;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null;
}

/** Tolerant parser for an OpenAI-compatible chat completion response. */
export function parseChatCompletion(
  json: unknown,
  fallbackModel: string,
): CompletionResult {
  const obj = (json ?? {}) as ChatCompletionShape;
  const content = obj.choices?.[0]?.message?.content;
  const usage = obj.usage ?? null;
  return {
    text: typeof content === 'string' ? content : '',
    model: typeof obj.model === 'string' ? obj.model : fallbackModel,
    usage:
      usage === null
        ? null
        : {
            promptTokens: numberOrUndefined(usage.prompt_tokens),
            completionTokens: numberOrUndefined(usage.completion_tokens),
          },
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
