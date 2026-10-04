import type {
  CompletionRequest,
  CompletionResult,
  ModelInfo,
  ModelProvider,
} from '@idearelay/contracts';

export const MOCK_MODEL_ID = 'mock-model-v1';

/** One deterministic requirement proposed by the mock's structured output. */
export interface MockSplitFixtureEntry {
  title: string;
  body: string;
  startMs: number;
  endMs: number;
}

export interface MockModelOptions {
  /**
   * Fixture returned whenever a request carries `responseFormatJsonSchema`
   * (i.e. the M3 split's structured-output call). Drives a deterministic
   * multi-requirement split fully offline (spec §7.2, §10).
   */
  splitFixture?: readonly MockSplitFixtureEntry[];
}

/**
 * Offline, deterministic `ModelProvider` (spec §7.2). Plain requests always
 * return the same summary (M2); structured requests return the configured
 * split fixture verbatim, or — with no fixture — a deterministic two-way split
 * derived from the transcript JSON in the prompt, so M3 tests are fully
 * network-free. The real path is the OpenAI-compatible provider.
 */
export function createMockModelProvider(
  model: string = MOCK_MODEL_ID,
  options: MockModelOptions = {},
): ModelProvider {
  return {
    id: 'mock',
    models(): ModelInfo[] {
      return [{ id: model, contextWindow: 8_192, structuredOutput: true }];
    },
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const input = req.messages.map((m) => m.content).join('\n');
      if (req.responseFormatJsonSchema != null) {
        const split = options.splitFixture !== undefined
          ? mockSplitFromFixture(options.splitFixture)
          : mockSplitFromPrompt(req.messages);
        return {
          text: JSON.stringify({ requirements: split }),
          model: req.model !== '' ? req.model : model,
          usage: null,
        };
      }
      const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
      if (system.includes(TRANSLATOR_MARKER)) {
        return {
          text: renderMockTranslation(input),
          model: req.model !== '' ? req.model : model,
          usage: null,
        };
      }
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

/**
 * Substring of the bilingual pipeline's system prompt that switches the mock
 * into translator mode (spec §15). The real path is the OpenAI-compatible
 * provider; the mock only guarantees a deterministic offline rendering.
 */
const TRANSLATOR_MARKER = '翻译器';

/**
 * Deterministic pseudo-translation: every `序号| 原文` line is echoed back as
 * `序号| [en] 原文` with order and numbering preserved. Non-numbered lines
 * (the system prompt) are ignored.
 */
export function renderMockTranslation(input: string): string {
  const out: string[] = [];
  for (const line of input.split('\n')) {
    const match = /^(\d+)\|\s?(.*)$/.exec(line.trim());
    if (match !== null) {
      out.push(`${match[1]}| [en] ${match[2]}`);
    }
  }
  return out.join('\n');
}

function mockSplitFromFixture(
  fixture: readonly MockSplitFixtureEntry[],
): MockSplitFixtureEntry[] {
  return fixture.map((entry) => ({ ...entry }));
}

interface PromptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * Fixture-less default: parse the `<transcript>` JSON the split pipeline sends
 * and split its segments into two deterministic halves. Fallback: one
 * requirement spanning the whole input. Always ≥1, deterministic, offline.
 */
export function mockSplitFromPrompt(
  messages: CompletionRequest['messages'],
): MockSplitFixtureEntry[] {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const content = lastUser?.content ?? '';
  const match = /<transcript>\n([\s\S]*?)\n<\/transcript>/.exec(content);
  if (match !== null) {
    try {
      const parsed = JSON.parse(match[1]) as { segments?: PromptSegment[] };
      const segments = parsed.segments ?? [];
      if (segments.length > 0) {
        if (segments.length === 1) {
          const seg = segments[0];
          return [
            { title: 'Part 1', body: seg.text, startMs: seg.startMs, endMs: seg.endMs },
          ];
        }
        const k = Math.ceil(segments.length / 2);
        return [segments.slice(0, k), segments.slice(k)].map((group, i) => ({
          title: `Part ${i + 1}`,
          body: group.map((s) => s.text).join('\n'),
          startMs: group[0].startMs,
          endMs: group[group.length - 1].endMs,
        }));
      }
    } catch {
      // Fall through to the whole-input requirement.
    }
  }
  return [{ title: 'Part 1', body: content, startMs: 0, endMs: 0 }];
}
