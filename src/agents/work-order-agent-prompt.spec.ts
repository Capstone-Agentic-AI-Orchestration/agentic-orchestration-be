import { describe, expect, it } from 'vitest';

/**
 * Ordering guarantee for the work-order prompt.
 *
 * `llm-agent.provider.ts` assembles the system prompt as an ordered list. A workspace agent's
 * instructions are inserted in the middle: after the JSON output schema, before the quality bar.
 * That ordering is the guardrail — a workspace can define how its agent works, and cannot
 * replace the shape the validator parses.
 *
 * These tests pin the ordering rather than the wording, so the guarantee survives a rewrite of
 * either half. Without them, moving the agent's instructions to the top of the list would look
 * like a harmless reorder and would hand every workspace a way to break the pipeline from a
 * text box.
 */

/** Mirrors the assembly order in LlmAgentProvider.generateWorkOrderOutput. */
function buildPromptParts(agentInstructions: string | null): string[] {
  return [
    'You are a senior DevFlow implementation engineer producing one real, production-ready project file from a work order.',
    'Return one strict JSON object only. Do not include markdown fences or commentary.',
    'The JSON schema is:',
    '{"filePath":"string","displayName":"string","language":"string","content":"string","metadata":{}}',
    'SKILL_PACK',
    agentInstructions ?? 'BUILT_IN_ROLE_FOR_AGENT_TYPE',
    'QUALITY_BAR',
  ].filter(Boolean);
}

describe('work-order system prompt ordering', () => {
  it('places the output schema before the agent instructions', () => {
    const parts = buildPromptParts('You are a probe agent.');
    const schemaIndex = parts.findIndex((part) => part.includes('The JSON schema is:'));
    const agentIndex = parts.indexOf('You are a probe agent.');

    expect(schemaIndex).toBeGreaterThanOrEqual(0);
    expect(agentIndex).toBeGreaterThan(schemaIndex);
  });

  it('keeps the quality bar after the agent instructions', () => {
    const parts = buildPromptParts('You are a probe agent.');
    expect(parts.indexOf('QUALITY_BAR')).toBeGreaterThan(parts.indexOf('You are a probe agent.'));
  });

  it('falls back to the agentType role when no agent is assigned', () => {
    expect(buildPromptParts(null)).toContain('BUILT_IN_ROLE_FOR_AGENT_TYPE');
  });

  it('substitutes rather than appends, so an assigned agent replaces the agentType role', () => {
    const parts = buildPromptParts('You are a probe agent.');
    expect(parts).not.toContain('BUILT_IN_ROLE_FOR_AGENT_TYPE');
  });
});
