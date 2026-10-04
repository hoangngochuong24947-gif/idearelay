import type { Certainty, DecisionPrimitive } from '@idearelay/contracts';
import type { SqliteDb } from '../types.js';

/** Raw `decisions` row (§5.3) — the audit of every DecisionProvider call. */
export interface DecisionRow {
  id: string;
  subject_type: string;
  subject_id: string;
  primitive: DecisionPrimitive;
  question: string;
  options_json: string | null;
  answer_json: string | null;
  confidence: number | null;
  certainty: Certainty | null;
  provider: string | null;
  model_version: string | null;
  created_at: number;
}

export interface NewDecision {
  id: string;
  subjectType: string;
  subjectId: string;
  primitive: DecisionPrimitive;
  question: string;
  optionsJson: string | null;
  answerJson: string | null;
  confidence: number | null;
  certainty: Certainty | null;
  provider: string | null;
  modelVersion: string | null;
  createdAt: number;
}

export function insertDecision(sqlite: SqliteDb, d: NewDecision): void {
  sqlite
    .prepare(
      `INSERT INTO decisions
         (id, subject_type, subject_id, primitive, question, options_json,
          answer_json, confidence, certainty, provider, model_version, created_at)
       VALUES (@id, @subject_type, @subject_id, @primitive, @question, @options_json,
               @answer_json, @confidence, @certainty, @provider, @model_version,
               @created_at)`,
    )
    .run({
      id: d.id,
      subject_type: d.subjectType,
      subject_id: d.subjectId,
      primitive: d.primitive,
      question: d.question,
      options_json: d.optionsJson,
      answer_json: d.answerJson,
      confidence: d.confidence,
      certainty: d.certainty,
      provider: d.provider,
      model_version: d.modelVersion,
      created_at: d.createdAt,
    });
}

export function listDecisions(
  sqlite: SqliteDb,
  filter: { subjectType?: string; subjectId?: string; primitive?: DecisionPrimitive } = {},
): DecisionRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.subjectType !== undefined) {
    clauses.push('subject_type = ?');
    params.push(filter.subjectType);
  }
  if (filter.subjectId !== undefined) {
    clauses.push('subject_id = ?');
    params.push(filter.subjectId);
  }
  if (filter.primitive !== undefined) {
    clauses.push('primitive = ?');
    params.push(filter.primitive);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return sqlite
    .prepare(`SELECT * FROM decisions ${where} ORDER BY created_at ASC, id ASC`)
    .all(...params) as DecisionRow[];
}

export function countDecisions(sqlite: SqliteDb): number {
  const row = sqlite.prepare('SELECT COUNT(*) AS n FROM decisions').get() as {
    n: number;
  };
  return row.n;
}
