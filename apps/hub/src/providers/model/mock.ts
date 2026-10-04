import type {
  CompletionRequest,
  CompletionResult,
  ModelInfo,
  ModelProvider,
} from '@idearelay/contracts';

export const MOCK_MODEL_ID = 'mock-model-v1';

/**
 * Offline, deterministic summarizer (spec §7.2). Given the same prompt it always
 * returns the same summary, so M2 tests are fully network-free. The real
 * summarization path is the OpenAI-compatible provider; production can pin a
 * small local model through it.
 */
export function createMockModelProvider(model: string = MOCK_MODEL_ID): ModelProvider {
  return {
    id: 'mock',
    models(): ModelInfo[] {
      return [{ id: model, contextWindow: 8_192, structuredOutput: false }];
    },
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const input = req.messages.map((m) => m.content).join('\n');
      return {
        text: renderMockSummary(input),
        model: req.model !== '' ? req.model : model,
        usage: null,
      };
    },
  };
}

/** Pure, deterministic summary renderer (no wall-clock, no randomness). */
export function renderMockSummary(input: string): string {
  const text = input.trim();
  const chars = text.length;
  const lines = text === '' ? 0 : text.split('\n').length;
  const head = text.slice(0, 120).replace(/\s+/g, ' ');
  const ellipsis = chars > 120 ? '…' : '';
  return `Mock summary: ${chars} chars across ${lines} lines. Key content: ${head}${ellipsis}`;
}
