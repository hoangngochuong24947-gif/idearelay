import { randomUUID } from 'node:crypto';
import type { SqliteDb } from '../types.js';
import type { StageDetail } from '../../workflows/types.js';

/** Raw `workflow_runs` row (§5.4). Rows are truth (ADR-0002). */
export interface WorkflowRunRow {
  id: string;
  spec_id: string;
  subject_type: string;
  subject_id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'rolled_back';
  grant_json: string | null;
  workspace_path: string | null;
  created_at: number;
  finished_at: number | null;
}

/** Raw `run_stages` row (§5.4) — one per spec stage, created with the run. */
export interface RunStageRow {
  id: string;
  run_id: string;
  name: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  started_at: number | null;
  ended_at: number | null;
  detail_json: string | null;
}

/** Raw `artifacts` row (§5.7). */
export interface ArtifactRow {
  id: string;
  run_id: string | null;
  kind: string;
  path: string;
  checksum: string | null;
  created_at: number;
}

export function insertWorkflowRun(
  sqlite: SqliteDb,
  run: {
    id: string;
    specId: string;
    subjectType: string;
    subjectId: string;
    status: WorkflowRunRow['status'];
    grantJson: string | null;
    workspacePath: string | null;
    createdAt: number;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO workflow_runs
         (id, spec_id, subject_type, subject_id, status, grant_json, workspace_path, created_at, finished_at)
       VALUES (@id, @spec_id, @subject_type, @subject_id, @status, @grant_json, @workspace_path, @created_at, NULL)`,
    )
    .run({
      id: run.id,
      spec_id: run.specId,
      subject_type: run.subjectType,
      subject_id: run.subjectId,
      status: run.status,
      grant_json: run.grantJson,
      workspace_path: run.workspacePath,
      created_at: run.createdAt,
    });
}

export function getWorkflowRun(sqlite: SqliteDb, id: string): WorkflowRunRow | null {
  const row = sqlite
    .prepare('SELECT * FROM workflow_runs WHERE id = ?')
    .get(id) as WorkflowRunRow | undefined;
  return row ?? null;
}

export function listWorkflowRuns(sqlite: SqliteDb): WorkflowRunRow[] {
  return sqlite
    .prepare('SELECT * FROM workflow_runs ORDER BY created_at ASC, id ASC')
    .all() as WorkflowRunRow[];
}

/** Idempotency per subject: at most one run per (subject_type, subject_id). */
export function findRunBySubject(
  sqlite: SqliteDb,
  subjectType: string,
  subjectId: string,
): WorkflowRunRow | null {
  const row = sqlite
    .prepare(
      'SELECT * FROM workflow_runs WHERE subject_type = ? AND subject_id = ? LIMIT 1',
    )
    .get(subjectType, subjectId) as WorkflowRunRow | undefined;
  return row ?? null;
}

export function updateRunStatus(
  sqlite: SqliteDb,
  id: string,
  status: WorkflowRunRow['status'],
  finishedAt: number | null = null,
): void {
  sqlite
    .prepare('UPDATE workflow_runs SET status = ?, finished_at = ? WHERE id = ?')
    .run(status, finishedAt, id);
}

/** Runs still marked `running` — the crash-recovery scan input (§6/§11). */
export function listRunningRuns(sqlite: SqliteDb): WorkflowRunRow[] {
  return sqlite
    .prepare("SELECT * FROM workflow_runs WHERE status = 'running' ORDER BY created_at ASC")
    .all() as WorkflowRunRow[];
}

export function insertRunStages(
  sqlite: SqliteDb,
  stages: Array<{ id: string; runId: string; name: string }>,
): void {
  const stmt = sqlite.prepare(
    `INSERT INTO run_stages (id, run_id, name, status, started_at, ended_at, detail_json)
     VALUES (@id, @run_id, @name, 'pending', NULL, NULL, NULL)`,
  );
  for (const stage of stages) {
    stmt.run({ id: stage.id, run_id: stage.runId, name: stage.name });
  }
}

export function listRunStages(sqlite: SqliteDb, runId: string): RunStageRow[] {
  return sqlite
    .prepare('SELECT * FROM run_stages WHERE run_id = ? ORDER BY rowid ASC')
    .all(runId) as RunStageRow[];
}

export function getRunStage(sqlite: SqliteDb, stageId: string): RunStageRow | null {
  const row = sqlite
    .prepare('SELECT * FROM run_stages WHERE id = ?')
    .get(stageId) as RunStageRow | undefined;
  return row ?? null;
}

export function updateRunStage(
  sqlite: SqliteDb,
  stageId: string,
  fields: {
    status?: RunStageRow['status'];
    startedAt?: number | null;
    endedAt?: number | null;
    detail?: StageDetail | null;
  },
): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id: stageId };
  if (fields.status !== undefined) {
    sets.push('status = @status');
    params.status = fields.status;
  }
  if (fields.startedAt !== undefined) {
    sets.push('started_at = @started_at');
    params.started_at = fields.startedAt;
  }
  if (fields.endedAt !== undefined) {
    sets.push('ended_at = @ended_at');
    params.ended_at = fields.endedAt;
  }
  if (fields.detail !== undefined) {
    sets.push('detail_json = @detail_json');
    params.detail_json = fields.detail === null ? null : JSON.stringify(fields.detail);
  }
  sqlite
    .prepare(`UPDATE run_stages SET ${sets.join(', ')} WHERE id = @id`)
    .run(params);
}

export function parseStageDetail(row: RunStageRow): StageDetail | null {
  if (row.detail_json === null) return null;
  try {
    return JSON.parse(row.detail_json) as StageDetail;
  } catch {
    return null;
  }
}

export function insertArtifact(
  sqlite: SqliteDb,
  artifact: { id?: string; runId: string; kind: string; path: string; checksum: string | null; createdAt: number },
): ArtifactRow {
  const id = artifact.id ?? randomUUID();
  sqlite
    .prepare(
      `INSERT INTO artifacts (id, run_id, kind, path, checksum, created_at)
       VALUES (@id, @run_id, @kind, @path, @checksum, @created_at)`,
    )
    .run({
      id,
      run_id: artifact.runId,
      kind: artifact.kind,
      path: artifact.path,
      checksum: artifact.checksum,
      created_at: artifact.createdAt,
    });
  return {
    id,
    run_id: artifact.runId,
    kind: artifact.kind,
    path: artifact.path,
    checksum: artifact.checksum,
    created_at: artifact.createdAt,
  };
}

export function listArtifacts(sqlite: SqliteDb, runId: string): ArtifactRow[] {
  return sqlite
    .prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC')
    .all(runId) as ArtifactRow[];
}

/**
 * Requirements eligible for an auto-run (§8.1 gate): created by a **gate
 * auto-advanced** `requirement` classification (`item.auto_accepted` event with
 * `kind: "requirement"` on the source revision) and without a run yet.
 * Idempotency is enforced again at start time via `findRunBySubject`.
 */
export function listRequirementsEligibleForRun(sqlite: SqliteDb): string[] {
  const rows = sqlite
    .prepare(
      `SELECT r.id FROM requirements r
        WHERE r.source_revision_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM events e
             WHERE e.aggregate_type = 'transcript_revision'
               AND e.aggregate_id = r.source_revision_id
               AND e.type = 'item.auto_accepted'
               AND e.payload_json LIKE '%"kind":"requirement"%'
          )
          AND NOT EXISTS (
            SELECT 1 FROM workflow_runs w
             WHERE w.subject_type = 'requirement' AND w.subject_id = r.id
          )`,
    )
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
