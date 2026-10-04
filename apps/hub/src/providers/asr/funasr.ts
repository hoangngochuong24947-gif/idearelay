import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type {
  AsrProvider,
  AudioRef,
  TranscribeOpts,
  TranscriptResult,
  TranscriptSegmentResult,
} from '@idearelay/contracts';

export const FUNASR_ASR_ID = 'funasr';

export interface FunasrOptions {
  /** e.g. http://127.0.0.1:8000 — the OpenAI-compatible FunASR service. */
  baseUrl: string;
  /** Model name the service expects, e.g. `paraformer-zh`. */
  model: string;
  /** Request timeout in ms. Defaults to 120_000 (long recordings). */
  timeoutMs?: number;
  /** Optional bearer token (credentials read from env by the caller). */
  apiKey?: string | null;
}

/**
 * Real Final-transcription provider (spec §7.1, ADR-0007). Calls a FunASR
 * OpenAI-compatible HTTP service (`POST {baseUrl}/v1/audio/transcriptions`) with
 * the audio as multipart form data plus hotword / language options. Not exercised
 * offline — the mock provider covers the acceptance test.
 */
export function createFunasrAsrProvider(opts: FunasrOptions): AsrProvider {
  const endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/v1/audio/transcriptions`;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return {
    id: FUNASR_ASR_ID,
    capabilities: {
      streaming: false,
      maxSessionDurationMs: null,
      hotwords: true,
      diarization: true,
      languages: ['zh', 'en'],
      revisions: ['final'],
      resume: false,
    },
    async transcribe(
      audio: AudioRef,
      transcribeOpts: TranscribeOpts,
    ): Promise<TranscriptResult> {
      const bytes = await readFile(audio.path);
      const form = new FormData();
      form.append(
        'file',
        new Blob([bytes], { type: audio.mime || 'application/octet-stream' }),
        basename(audio.path),
      );
      form.append('model', opts.model);
      if (transcribeOpts.languageHints?.[0] !== undefined) {
        form.append('language', transcribeOpts.languageHints[0]);
      }
      if (transcribeOpts.hotwords !== undefined && transcribeOpts.hotwords.length > 0) {
        form.append('hotword', transcribeOpts.hotwords.join(' '));
      }
      if (transcribeOpts.diarization === true) {
        form.append('diarization', 'true');
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          body: form,
          headers:
            opts.apiKey != null && opts.apiKey.length > 0
              ? { authorization: `Bearer ${opts.apiKey}` }
              : undefined,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `funasr request failed: ${response.status} ${response.statusText} ${body}`.trim(),
        );
      }

      const json: unknown = await response.json();
      return {
        revisionKind: 'final',
        providerId: FUNASR_ASR_ID,
        model: opts.model,
        languageHints: transcribeOpts.languageHints ?? null,
        segments: parseFunasrSegments(json, audio),
      };
    },
  };
}

/**
 * Tolerant parser for the two shapes a FunASR OpenAI-compatible service returns:
 *   - OpenAI `verbose_json`: `{ segments: [{ start(s), end(s), text }] }`
 *   - FunASR native:          `{ text, sentence_info: [{ start(ms), end(ms), text }] }`
 * Falls back to a single full-span segment when only `text` is present.
 */
export function parseFunasrSegments(
  json: unknown,
  audio: AudioRef,
): TranscriptSegmentResult[] {
  const obj = (json ?? {}) as Record<string, unknown>;

  if (Array.isArray(obj.segments)) {
    return obj.segments.map((raw, i) => {
      const s = (raw ?? {}) as Record<string, unknown>;
      return {
        idx: i,
        startMs: Math.round(secondsToMs(s.start)),
        endMs: Math.round(secondsToMs(s.end)),
        text: String(s.text ?? '').trim(),
        speaker: typeof s.speaker === 'string' ? s.speaker : null,
        confidence: typeof s.confidence === 'number' ? s.confidence : null,
      };
    });
  }

  if (Array.isArray(obj.sentence_info)) {
    return obj.sentence_info.map((raw, i) => {
      const s = (raw ?? {}) as Record<string, unknown>;
      return {
        idx: i,
        startMs: numberOr(s.start, 0),
        endMs: numberOr(s.end, 0),
        text: String(s.text ?? '').trim(),
        speaker: typeof s.spk === 'string' ? s.spk : null,
        confidence: null,
      };
    });
  }

  const text = typeof obj.text === 'string' ? obj.text.trim() : '';
  return [
    {
      idx: 0,
      startMs: 0,
      endMs: audio.durationMs ?? 0,
      text,
      speaker: null,
      confidence: null,
    },
  ];
}

function secondsToMs(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n * 1000 : 0;
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}
