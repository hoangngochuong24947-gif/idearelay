import {
  DEFAULT_DECISION_THRESHOLDS,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResult,
  type DecisionThresholds,
} from '@idearelay/contracts';

export const JEV_DECISION_ID = 'jev';

export const JEV_DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export interface JevOptions {
  /** SystemOne endpoint. Defaults to the official one. */
  endpoint?: string;
  /**
   * Pinned model name — **must not** be the moving `jev-latest` alias
   * (ADR-0005). Required.
   */
  model: string;
  /** TYPESAFE_API_KEY, read from env by the caller. */
  apiKey: string;
  /** Request timeout in ms. Defaults to 30_000. */
  timeoutMs?: number;
  /** Default thresholds baked into the request; per-call overrides win. */
  thresholds?: DecisionThresholds;
  fetchImpl?: typeof fetch;
}

/**
 * Jev (`POST /v1/systemone`) `DecisionProvider` — the first real implementation
 * of ADR-0005. It sends exactly one primitive (choice / score / noul) per call,
 * always pins the model, and passes per-call `thresholdOverrides` merged over the
 * (officially UNCALIBRATED) defaults. The response maps back onto
 * `confidence` / `certainty` / `abstained` / `modelVersion`. Not exercised
 * offline — tests use the mock provider.
 */
export function createJevDecisionProvider(opts: JevOptions): DecisionProvider {
  const endpoint = opts.endpoint ?? JEV_DEFAULT_ENDPOINT;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const doFetch = opts.fetchImpl ?? fetch;
  const defaults = opts.thresholds ?? DEFAULT_DECISION_THRESHOLDS;

  return {
    id: JEV_DECISION_ID,
    async decide(req: DecisionRequest): Promise<DecisionResult> {
      const thresholds: DecisionThresholds = {
        high: req.thresholdOverrides?.high ?? defaults.high,
        low: req.thresholdOverrides?.low ?? defaults.low,
        noulBand: req.thresholdOverrides?.noulBand ?? defaults.noulBand,
      };

      const body = buildJevRequestBody(req, opts.model, thresholds);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${opts.apiKey}`,
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
          `jev request failed: ${response.status} ${response.statusText} ${detail}`.trim(),
        );
      }

      const json: unknown = await response.json();
      return parseJevResult(json, req, opts.model, thresholds);
    },
  };
}

/** Build the SystemOne request body, omitting absent primitive fields. */
export function buildJevRequestBody(
  req: DecisionRequest,
  model: string,
  thresholds: DecisionThresholds,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    primitive: req.primitive,
    question: req.question,
    thresholds: {
      confidence_high: thresholds.high,
      confidence_low: thresholds.low,
      noul_band: thresholds.noulBand,
    },
  };
  if (req.options !== undefined) body.options = req.options;
  if (req.scale !== undefined) body.scale = req.scale;
  return body;
}

interface JevResponseShape {
  primitive?: unknown;
  choice?: unknown;
  verdict?: unknown;
  probabilities?: unknown;
  score?: unknown;
  probability?: unknown;
  confidence?: unknown;
  certainty?: unknown;
  abstained?: unknown;
  needs_escalation?: unknown;
  modelVersion?: unknown;
  model_version?: unknown;
  model?: unknown;
}

/** Tolerant mapping of a SystemOne response onto a `DecisionResult`. */
export function parseJevResult(
  json: unknown,
  req: DecisionRequest,
  configuredModel: string,
  thresholds: DecisionThresholds,
): DecisionResult {
  const obj = (json ?? {}) as JevResponseShape;
  const probabilities = asNumberRecord(obj.probabilities);
  const choice = asString(obj.choice) ?? asString(obj.verdict) ?? topKey(probabilities);

  const confidence =
    asNumber(obj.confidence) ??
    (probabilities !== null && choice !== null && probabilities[choice] !== undefined
      ? probabilities[choice]
      : null) ??
    0;

  const certainty =
    normalizeCertainty(obj.certainty) ?? certaintyFor(confidence, thresholds);

  const abstained = asBoolean(obj.abstained) ?? asBoolean(obj.needs_escalation) ?? false;

  const result: DecisionResult = {
    primitive: normalizePrimitive(obj.primitive) ?? req.primitive,
    confidence,
    certainty,
    abstained,
    modelVersion:
      asString(obj.modelVersion) ??
      asString(obj.model_version) ??
      asString(obj.model) ??
      configuredModel,
  };
  if (choice !== null) result.choice = choice;
  if (probabilities !== null) result.probabilities = probabilities;
  const score = asNumber(obj.score);
  if (score !== null) result.score = score;
  const probability = asNumber(obj.probability);
  if (probability !== null) result.probability = probability;
  return result;
}

function normalizePrimitive(value: unknown): DecisionResult['primitive'] | null {
  return value === 'choice' || value === 'score' || value === 'noul' ? value : null;
}

function normalizeCertainty(value: unknown): DecisionResult['certainty'] | null {
  return value === 'high' || value === 'medium' || value === 'low' ? value : null;
}

function certaintyFor(
  confidence: number,
  thresholds: DecisionThresholds,
): DecisionResult['certainty'] {
  if (confidence >= thresholds.high) return 'high';
  if (confidence >= thresholds.low) return 'medium';
  return 'low';
}

function topKey(record: Record<string, number> | null): string | null {
  if (record === null) return null;
  let best: string | null = null;
  let bestValue = -Infinity;
  for (const [key, value] of Object.entries(record)) {
    if (value > bestValue) {
      best = key;
      bestValue = value;
    }
  }
  return best;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asNumberRecord(value: unknown): Record<string, number> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
  }
  return out;
}
