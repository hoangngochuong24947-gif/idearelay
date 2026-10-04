import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { StageContext } from './types.js';
import type { StageTool } from './stage-tools.js';

/**
 * Adapt a stage's whitelist of `StageTool`s to Pi `AgentTool`s. `ctx` is bound
 * here so the model-facing tool executes against the run's grant/workspace
 * (ADR-0006: the agent never sees credentials — only these whitelisted tools).
 */
export function toAgentTools(tools: StageTool[], ctx: StageContext): AgentTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // Plain JSON Schema: the Pi loop validates via its coercion path.
    parameters: tool.parameters,
    label: tool.name,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const result = await tool.execute(params, ctx);
      return {
        content: [{ type: 'text' as const, text: result.text }],
        details: result.output ?? null,
      };
    },
  })) as AgentTool[];
}
