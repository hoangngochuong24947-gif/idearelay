/** The 16 tables defined by spec §5. Used by migrations and verification. */
export const M0_TABLES = [
  'artifacts',
  'corpora',
  'corpus_docs',
  'decisions',
  'events',
  'inbox_items',
  'jobs',
  'providers',
  'recordings',
  'requirement_source_refs',
  'requirements',
  'run_stages',
  'segments',
  'transcript_revisions',
  'workflow_runs',
  'workflow_specs',
] as const;

export type M0Table = (typeof M0_TABLES)[number];
