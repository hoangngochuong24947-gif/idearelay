/**
 * Event seam (spec §5.6 / §6). Append-only `events` rows are written first; the
 * projection layer materializes them into tables/files afterwards. Payloads are
 * serialized as JSON, hence the envelope carries `payload` while the row carries
 * `payload_json`.
 */

export type EventAggregateType =
  | 'recording'
  | 'transcript_revision'
  | 'requirement'
  | 'inbox_item'
  | 'decision'
  | 'workflow_run'
  | 'run_stage'
  | 'job'
  | 'corpus'
  | 'artifact'
  | 'provider'
  | (string & {});

export interface EventEnvelope<P = unknown> {
  aggregateType: EventAggregateType;
  aggregateId: string;
  /** Monotonic per (aggregate_type, aggregate_id). */
  seq: number;
  type: string;
  payload: P;
  createdAt: number;
}

/** Persisted row shape of the `events` table (§5.6). */
export interface EventRecord {
  id: number;
  aggregateType: string;
  aggregateId: string;
  seq: number;
  type: string;
  payloadJson: string;
  createdAt: number;
}

/** Canonical event type constants. */
export const EVENT_TYPES = {
  RecordingReceived: 'recording.received',
  TranscriptRevisionCreated: 'transcript.revision.created',
  ProjectionWritten: 'projection.written',
  FileManuallyEdited: 'file.manually_edited',
} as const;

export type KnownEventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export function createEventEnvelope<P>(
  aggregateType: EventAggregateType,
  aggregateId: string,
  seq: number,
  type: string,
  payload: P,
  createdAt: number = Date.now(),
): EventEnvelope<P> {
  return { aggregateType, aggregateId, seq, type, payload, createdAt };
}
