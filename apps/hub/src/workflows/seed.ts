import type { SqliteDb } from '../db/types.js';
import type { WorkflowDefinition } from './types.js';

/** The §8.1 `requirement-research` spec, with minimal embedded prompt templates. */
export const REQUIREMENT_RESEARCH_SPEC_ID = 'requirement-research';

export const REQUIREMENT_RESEARCH_DEFINITION: WorkflowDefinition = {
  name: 'requirement-research',
  stages: [
    { name: 'rag-context', kind: 'tool', tool: 'rag.retrieve' },
    { name: 'scan-oss', kind: 'agent', tools: ['github.search'], promptTemplate: 'scan-oss' },
    {
      name: 'enrich',
      kind: 'agent',
      tools: ['rag.retrieve', 'web.search'],
      promptTemplate: 'to-prd',
    },
    { name: 'write', kind: 'tool', tool: 'projection.writeDeliverable' },
  ],
  gate: { autoRunWhen: { confidence_min: 0.8, abstained: false } },
  promptTemplates: {
    'scan-oss': {
      system:
        '你是 idearelay 的开源方案调研 agent。针对给定需求，用 github.search 工具查找现成的开源实现，' +
        '总结每个候选项目的成熟度与匹配度，最后给出「直接复用 / 部分借鉴 / 自研」的建议。',
      userTemplate:
        '需求：\n{{requirement}}\n\n请调研 GitHub 上的现成方案，并给出结论。',
    },
    'to-prd': {
      system:
        '你是 idearelay 的 to-PRD agent。把需求与调研结论整合成一份简洁的 PRD 草稿：' +
        '背景、目标、非目标、方案要点、验收标准。可以用 rag.retrieve 补背景、web.search 查资料。',
      userTemplate:
        '需求：\n{{requirement}}\n\n已有检索背景：\n{{rag}}\n\n开源调研结论：\n{{scan}}\n\n请输出 PRD 草稿。',
    },
  },
};

/**
 * Idempotently seed the M5 WorkflowSpec row (§8.1). Rows are truth — an
 * existing definition is never overwritten.
 */
export function seedWorkflowSpecs(sqlite: SqliteDb): boolean {
  const info = sqlite
    .prepare(
      `INSERT OR IGNORE INTO workflow_specs (id, name, definition_json, enabled, schedule)
       VALUES (?, ?, ?, 1, NULL)`,
    )
    .run(
      REQUIREMENT_RESEARCH_SPEC_ID,
      REQUIREMENT_RESEARCH_DEFINITION.name,
      JSON.stringify(REQUIREMENT_RESEARCH_DEFINITION),
    );
  return info.changes > 0;
}

export function getWorkflowSpec(sqlite: SqliteDb, id: string):
  | { id: string; name: string; definition_json: string; enabled: number; schedule: string | null }
  | null {
  const row = sqlite
    .prepare('SELECT * FROM workflow_specs WHERE id = ?')
    .get(id) as
    | { id: string; name: string; definition_json: string; enabled: number; schedule: string | null }
    | undefined;
  return row ?? null;
}
