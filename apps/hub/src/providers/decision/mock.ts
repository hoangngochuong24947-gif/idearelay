import {
  DEFAULT_DECISION_THRESHOLDS,
  INBOX_KINDS,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResult,
  type InboxKind,
} from '@idearelay/contracts';

export const MOCK_DECISION_ID = 'mock';
export const MOCK_DECISION_MODEL_VERSION = 'mock-decision-v1';

// The 7 top-level kinds are domain data (§9), reused as the default choice options.
export { INBOX_KINDS };

/** Default cue phrases per top-level kind (Chinese + English). */
const KIND_CUES: Record<string, string[]> = {
  requirement: ['需求', '需要', '应该支持', '我希望', '要做成', 'must', 'should', 'require', 'feature', '支持'],
  idea: ['想法', 'idea', '可以考虑', '也许可以', '概念', '点子'],
  log: ['今天', '昨天', '记录一下', '日志', 'log', 'diary', '回顾'],
  task: ['任务', '待办', 'todo', 'to-do', '记得', '别忘', 'action item', '跟进'],
  reference: ['参考', '资料', '链接', '文档', 'reference', 'link', '素材'],
  question: ['？', '?', '怎么办', '如何', '为什么', '是不是', '能不能', 'question'],
  unknown: [],
};

/** Default tag vocabulary + cues (打标). */
const TAG_CUES: Record<string, string[]> = {
  product: ['产品', 'product', '用户', '体验'],
  tech: ['技术', 'tech', '架构', '代码', 'api', '数据库', 'sqlite'],
  design: ['设计', 'design', '界面', 'ui', '交互'],
  ops: ['运维', 'ops', '部署', '服务器', '监控'],
  personal: ['个人', 'personal', '生活', '健康'],
};

/** Kind cues + tag cues merged (disjoint keys) so any choice call resolves. */
const COMBINED_CUES: Record<string, string[]> = { ...KIND_CUES, ...TAG_CUES };

function resolvedCues(override?: Record<string, string[]>): Record<string, string[]> {
  return override === undefined ? COMBINED_CUES : { ...COMBINED_CUES, ...override };
}

export interface MockDecisionConfig {
  /** Confidence when a cue matched. Default 0.9 (≥ the 0.8 gate). */
  highConfidence?: number;
  /** Confidence when nothing matched. Default 0.4 (< the 0.8 gate). */
  lowConfidence?: number;
  /** Abstain (instead of merely low-confidence) when nothing matched. */
  abstainOnNoMatch?: boolean;
  /** Force abstention regardless of input — for exercising the gate. */
  alwaysAbstain?: boolean;
  /** Cue overrides, keyed by option string. */
  cues?: Record<string, string[]>;
}

interface Scored {
  option: string;
  matches: number;
}

/**
 * Deterministic offline `DecisionProvider` (ADR-0005). It scores each option by
 * counting cue phrases in the question and returns a calibrated-shaped result:
 * a matched cue yields high confidence, no cue yields low confidence (or
 * abstention). Tests use `abstainOnNoMatch` / `alwaysAbstain` / confidence knobs
 * to force the gate either way — all without a network call.
 */
export function createMockDecisionProvider(
  config: MockDecisionConfig = {},
): DecisionProvider {
  const highConfidence = config.highConfidence ?? 0.9;
  const lowConfidence = config.lowConfidence ?? 0.4;

  return {
    id: MOCK_DECISION_ID,
    async decide(req: DecisionRequest): Promise<DecisionResult> {
      const thresholds = {
        high: req.thresholdOverrides?.high ?? DEFAULT_DECISION_THRESHOLDS.high,
        low: req.thresholdOverrides?.low ?? DEFAULT_DECISION_THRESHOLDS.low,
        noulBand: req.thresholdOverrides?.noulBand ?? DEFAULT_DECISION_THRESHOLDS.noulBand,
      };

      if (req.primitive === 'noul') {
        return decideNoul(req, config, thresholds, highConfidence, lowConfidence);
      }
      if (req.primitive === 'score') {
        return decideScore(req, thresholds);
      }
      return decideChoice(req, config, thresholds, highConfidence, lowConfidence);
    },
  };
}

function decideChoice(
  req: DecisionRequest,
  config: MockDecisionConfig,
  thresholds: { high: number; low: number },
  highConfidence: number,
  lowConfidence: number,
): DecisionResult {
  const options = req.options ?? [...INBOX_KINDS];
  const cues = resolvedCues(config.cues);
  const scored = scoreOptions(req.question, options, cues);
  const top = pickTop(scored);
  const matched = top !== null && top.matches > 0;

  let chosen: string;
  let confidence: number;
  let abstained = config.alwaysAbstain === true;

  if (matched) {
    chosen = top.option;
    confidence = highConfidence;
  } else {
    chosen =
      options.find((o) => o === 'unknown') ?? options[0] ?? 'unknown';
    confidence = lowConfidence;
    if (config.abstainOnNoMatch === true) abstained = true;
  }

  const probabilities = distribute(confidence, options, chosen);
  return {
    primitive: 'choice',
    choice: chosen,
    probabilities,
    confidence,
    certainty: certaintyFor(confidence, thresholds),
    abstained,
    modelVersion: MOCK_DECISION_MODEL_VERSION,
  };
}

function decideNoul(
  req: DecisionRequest,
  config: MockDecisionConfig,
  thresholds: { high: number; low: number; noulBand: [number, number] },
  highConfidence: number,
  lowConfidence: number,
): DecisionResult {
  const cues = resolvedCues(config.cues);
  const probability = totalCueHits(req.question, cues) > 0 ? highConfidence : lowConfidence;
  const inBand = probability >= thresholds.noulBand[0] && probability <= thresholds.noulBand[1];
  const abstained = config.alwaysAbstain === true || inBand;
  return {
    primitive: 'noul',
    probability,
    confidence: probability,
    certainty: certaintyFor(probability, thresholds),
    abstained,
    modelVersion: MOCK_DECISION_MODEL_VERSION,
  };
}

function decideScore(
  req: DecisionRequest,
  thresholds: { high: number; low: number },
): DecisionResult {
  const min = req.scale?.min ?? 0;
  const max = req.scale?.max ?? 1;
  const score = (min + max) / 2;
  const confidence = 0.75;
  return {
    primitive: 'score',
    score,
    confidence,
    certainty: certaintyFor(confidence, thresholds),
    abstained: false,
    modelVersion: MOCK_DECISION_MODEL_VERSION,
  };
}

/** Count cue hits per option; deterministic and case-insensitive. */
export function scoreOptions(
  text: string,
  options: readonly string[],
  cues: Record<string, string[]>,
): Scored[] {
  const haystack = text.toLowerCase();
  return options.map((option) => {
    const phrases = cues[option] ?? [option.toLowerCase()];
    let matches = 0;
    for (const phrase of phrases) {
      const needle = phrase.toLowerCase();
      if (needle.length === 0) continue;
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at === -1) break;
        matches += 1;
        from = at + needle.length;
      }
    }
    return { option, matches };
  });
}

function pickTop(scored: readonly Scored[]): Scored | null {
  let best: Scored | null = null;
  for (const s of scored) {
    if (best === null || s.matches > best.matches) best = s;
  }
  return best;
}

/** Total cue hits across every option's cue list (used by the noul primitive). */
function totalCueHits(text: string, cues: Record<string, string[]>): number {
  return scoreOptions(text, Object.keys(cues), cues).reduce(
    (sum, s) => sum + s.matches,
    0,
  );
}

/** Top option gets `confidence`; the remainder is spread evenly over the rest. */
function distribute(
  confidence: number,
  options: readonly string[],
  chosen: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  const rest = options.length > 1 ? (1 - confidence) / (options.length - 1) : 0;
  for (const option of options) {
    out[option] = option === chosen ? round4(confidence) : round4(rest);
  }
  return out;
}

function certaintyFor(
  confidence: number,
  thresholds: { high: number; low: number },
): DecisionResult['certainty'] {
  if (confidence >= thresholds.high) return 'high';
  if (confidence >= thresholds.low) return 'medium';
  return 'low';
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Tag vocabulary exposed for the enrich pipeline's tagging call. */
export function tagVocabulary(): string[] {
  return Object.keys(TAG_CUES);
}

export function kindVocabulary(): readonly InboxKind[] {
  return INBOX_KINDS;
}
