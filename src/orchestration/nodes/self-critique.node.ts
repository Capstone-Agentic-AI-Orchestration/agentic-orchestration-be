import { Injectable, Logger } from '@nestjs/common';
import { DevFlowStateType } from '../graph/devflow.state';
import { NODE } from '../graph/topology';
import { StreamEmitter } from '../streaming/stream-emitter.service';
import { AgentLlmRouter } from '../providers/agent-llm.router';
import { resolveModelForNode } from '../providers/base-llm.provider';
import { buildContractSummary } from '../prompts/agent-prompts';
import { humanReadableError } from './human-readable-error';

const SELF_CRITIQUE_SYSTEM = `You are a senior code reviewer. You will receive a set of generated artifacts and the project contract.
Your job is to review the artifacts against the contract's acceptance criteria and identify quality issues.

Return ONLY a valid JSON object — no markdown fences, no prose.

Shape:
{
  "verdict": "pass" | "issues",
  "issues": string[],
  "suggestions": string[]
}

Rules:
- Check each artifact against the acceptance criteria.
- Check for: placeholder code (TODOs, stubs, "implementation goes here"), missing imports, inconsistent naming, missing error handling, generic placeholder content (lorem ipsum, "example.com"), and type safety violations (any types, untyped params).
- Check cross-file consistency: do frontend API calls match backend routes? Do Prisma usages match schema models?
- Be specific: reference file paths and exact issues.
- If everything looks solid, return {"verdict":"pass","issues":[],"suggestions":[]}.`;

@Injectable()
export class SelfCritiqueNode {
  private readonly logger = new Logger(SelfCritiqueNode.name);

  constructor(
    private readonly streamEmitter: StreamEmitter,
    private readonly llm: AgentLlmRouter,
  ) {}

  async execute(
    state: DevFlowStateType,
  ): Promise<Partial<DevFlowStateType>> {
    const { projectId, runId } = state;

    // Skip if no contract or no artifacts
    if (!state.contract || !state.artifacts?.length) {
      return {};
    }

    // Skip in mock mode
    if (process.env.MOCK_MODE === 'true') {
      return {};
    }

    // Extract contract summary from backend/database artifacts for retry coordination
    const backendArtifacts = state.artifacts.filter((a) => a.agentType === 'backend');
    const databaseArtifacts = state.artifacts.filter((a) => a.agentType === 'database');
    const contractSummary = buildContractSummary(backendArtifacts, databaseArtifacts);

    // Skip self-critique LLM call if disabled
    if (process.env.SELF_CRITIQUE === 'false') {
      return contractSummary ? { contractSummary } : {};
    }

    this.streamEmitter.emit(projectId, NODE.SELF_CRITIQUE, runId ?? '', 'decision', 'Reviewing generated artifacts against contract...');
    this.streamEmitter.progress(projectId, NODE.SELF_CRITIQUE, runId ?? '', 50, 'Self-critique in progress');

    try {
      const artifactSummary = state.artifacts
        .map((a) => `[${a.agentType}] ${a.filePath} (${a.language}, ${a.content.length} chars)`)
        .join('\n');

      const artifactExcerpts = state.artifacts
        .slice(0, 8)
        .map((a) => {
          const excerpt = a.content.slice(0, 800);
          return `--- ${a.filePath} ---\n${excerpt}${a.content.length > 800 ? '\n...(truncated)' : ''}`;
        })
        .join('\n\n');

      const acceptanceCriteria = state.contract.acceptanceCriteria
        .map((c, i) => `${i + 1}. ${c}`)
        .join('\n');

      const userPrompt = `## Contract
Project: ${state.contract.projectName}
Description: ${state.contract.description}

## Acceptance Criteria
${acceptanceCriteria}

## Generated Artifacts (summary)
${artifactSummary}

## Artifact Excerpts
${artifactExcerpts}

Review these artifacts against the acceptance criteria. Return your verdict as JSON.`;

      const result = await this.llm.generateJson<{
        verdict: string;
        issues: string[];
        suggestions: string[];
      }>({
        agentName: resolveModelForNode('self_critique', 'self_critique'),
        subagent: 'self-critique',
        correlation: {
          projectId,
          runId,
          nodeId: NODE.SELF_CRITIQUE,
          agent: 'self-critique',
        },
        systemPrompt: SELF_CRITIQUE_SYSTEM,
        userPrompt,
        expectedShape: 'object',
      });

      const critique = result.value;

      if (critique.verdict === 'pass' && critique.issues.length === 0) {
        this.streamEmitter.emit(projectId, NODE.SELF_CRITIQUE, runId ?? '', 'decision', 'Self-critique passed: no quality issues found');
        return contractSummary ? { contractSummary } : {};
      }

      const issueCount = critique.issues.length;
      const suggestionCount = critique.suggestions.length;

      this.streamEmitter.emit(
        projectId,
        NODE.SELF_CRITIQUE,
        runId ?? '',
        'decision',
        `Self-critique found ${issueCount} issues and ${suggestionCount} suggestions`,
      );

      const feedback = [
        ...(critique.issues.length > 0
          ? ['QUALITY ISSUES:', ...critique.issues.map((i) => `• ${i}`)]
          : []),
        ...(critique.suggestions.length > 0
          ? ['IMPROVEMENT SUGGESTIONS:', ...critique.suggestions.map((s) => `• ${s}`)]
          : []),
      ].join('\n');

      return { selfCritique: feedback, contractSummary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[${projectId}] Self-critique failed (non-fatal): ${message}`);
      this.streamEmitter.emit(projectId, NODE.SELF_CRITIQUE, runId ?? '', 'decision', `Self-critique skipped: ${humanReadableError(message)}`);
      return contractSummary ? { contractSummary } : {};
    }
  }
}
