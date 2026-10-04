import type {
  AsrProvider,
  TranscribeOpts,
  TranscriptResult,
  TranscriptSegmentResult,
} from '@idearelay/contracts';

export const MOCK_ASR_ID = 'mock';
export const MOCK_ASR_MODEL = 'mock-asr-v1';

/**
 * A fixed, deterministic set of timed segments. Any audio file transcribes to
 * exactly this, so the M1 acceptance test is fully offline (spec §7.1, §18).
 */
const FIXED_SEGMENTS: readonly TranscriptSegmentResult[] = [
  {
    idx: 0,
    startMs: 0,
    endMs: 1_800,
    text: '这是 M1 mock 转写的第一段，用于验证时间戳。',
    speaker: 'speaker_1',
    confidence: 0.97,
  },
  {
    idx: 1,
    startMs: 1_800,
    endMs: 3_600,
    text: 'Second segment proves timed segments survive the pipeline.',
    speaker: 'speaker_1',
    confidence: 0.94,
  },
  {
    idx: 2,
    startMs: 3_600,
    endMs: 5_400,
    text: '第三段落盘为 transcript.final.md 投影。',
    speaker: 'speaker_2',
    confidence: 0.9,
  },
];

/**
 * Offline, network-free ASR provider. MVP capabilities: `streaming=false`,
 * `revisions=['final']` — Provisional is a placeholder written by the pipeline,
 * not produced here.
 */
export function createMockAsrProvider(): AsrProvider {
  return {
    id: MOCK_ASR_ID,
    capabilities: {
      streaming: false,
      maxSessionDurationMs: null,
      hotwords: false,
      diarization: false,
      languages: ['zh', 'en', 'mock'],
      revisions: ['final'],
      resume: false,
    },
    async transcribe(
      _audio,
      opts: TranscribeOpts,
    ): Promise<TranscriptResult> {
      return {
        revisionKind: 'final',
        providerId: MOCK_ASR_ID,
        model: MOCK_ASR_MODEL,
        languageHints: opts.languageHints ?? null,
        segments: FIXED_SEGMENTS.map((s) => ({ ...s })),
      };
    },
  };
}

export function mockSegmentCount(): number {
  return FIXED_SEGMENTS.length;
}
