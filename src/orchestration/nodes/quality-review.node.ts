import { Injectable, Logger } from '@nestjs/common';
import { QA_REVIEW_SYSTEM, SECURITY_REVIEW_SYSTEM, REVIEW_OUTPUT_CONTRACT } from '../prompts/agent-prompts';
import { resolveAgentSystemPrompt } from '../../agents/agent-prompt-resolver';
import { PrismaService } from '../../prisma/prisma.service';
import type { DevFlowStateType } from '../graph/devflow.state';
import { NODE } from '../graph/topology';
import { resolveModelForNode } from '../providers/base-llm.provider';
import { AgentLlmRouter } from '../providers/agent-llm.router';
import { StreamEmitter } from '../streaming/stream-emitter.service';
import { humanReadableError } from './human-readable-error';

type ReviewKind = 'qa' | 'security';

interface ReviewResult {
  verdict?: unknown;
  issues?: unknown;
  recommendations?: unknown;
}

@Injectable()
export class QualityReviewNode {
  private readonly logger = new Logger(QualityReviewNode.name);

  constructor(
    private readonly llm: AgentLlmRouter,
    private readonly streamEmitter: StreamEmitter,
    // Injected so the workspace's own instructions for the qa and security agents can be
    // resolved at dispatch, the same way the code agents resolve theirs.
    private readonly prisma: PrismaService,
  ) {}

  executeQa(state: DevFlowStateType): Promise<Partial<DevFlowStateType>> {
    return this.executeReview('qa', state);
  }

  executeSecurity(state: DevFlowStateType): Promise<Partial<DevFlowStateType>> {
    return this.executeReview('security', state);
  }

  private async executeReview(
    kind: ReviewKind,
    state: DevFlowStateType,
  ): Promise<Partial<DevFlowStateType>> {
    const nodeId = kind === 'qa' ? NODE.QA_REVIEW : NODE.SECURITY_REVIEW;
    const plan = state.contract?.agentPlan;
    if (!state.contract || !state.artifacts.length || !plan?.activeAgents.includes(kind)) {
      return kind === 'qa' ? { qaReview: '' } : { securityReview: '' };
    }

    if (process.env.MOCK_MODE === 'true') {
      return kind === 'qa'
        ? { qaReview: 'PASS\nNo QA blockers found in mock mode.' }
        : { securityReview: 'PASS\nNo security blockers found in mock mode.' };
    }

    const label = kind === 'qa' ? 'QA' : 'Security';
    this.streamEmitter.emit(
      state.projectId,
      nodeId,
      state.runId ?? '',
      'decision',
      `${label} reviewer is checking the joined implementation...`,
    );

    const artifactSummary = state.artifacts
      .map((artifact) =>
        `--- ${artifact.agentType}: ${artifact.filePath} ---\n${artifact.content.slice(0, 1_200)}`,
      )
      .join('\n\n')
      .slice(0, 24_000);
    const qaContext =
      kind === 'security' && state.qaReview
        ? `\n\nPrior QA review:\n${state.qaReview}`
        : '';
    // Role text is overridable by the workspace; the output contract is appended afterwards and
    // is not, because every caller parses that JSON shape.
    const roleText = await resolveAgentSystemPrompt(
      this.prisma,
      state.projectId,
      kind === 'qa' ? 'qa' : 'security-review',
      kind === 'qa' ? QA_REVIEW_SYSTEM : SECURITY_REVIEW_SYSTEM,
    );
    const systemPrompt = `${roleText}

${REVIEW_OUTPUT_CONTRACT}`;

    try {
      const result = await this.llm.generateJson<ReviewResult>({
        agentName: resolveModelForNode(
          kind === 'qa' ? 'qa_review' : 'security_review',
          kind === 'qa' ? 'qa_review' : 'security_review',
        ),
        subagent: kind === 'qa' ? 'qa' : 'security-review',
        correlation: {
          projectId: state.projectId,
          runId: state.runId,
          nodeId,
          agent: kind === 'qa' ? 'qa' : 'security-review',
        },
        systemPrompt,
        userPrompt: [
          `Project: ${state.contract.projectName}`,
          `Description: ${state.contract.description}`,
          `Acceptance criteria:\n${state.contract.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`,
          `Artifacts:\n${artifactSummary}`,
          qaContext,
        ].join('\n\n'),
        expectedShape: 'object',
      });
      const review = this.formatReview(result.value);
      this.streamEmitter.emit(
        state.projectId,
        nodeId,
        state.runId ?? '',
        'decision',
        `${label} review complete.`,
      );
      return kind === 'qa' ? { qaReview: review } : { securityReview: review };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[${state.projectId}] ${label} review failed (non-fatal): ${message}`);
      this.streamEmitter.emit(
        state.projectId,
        nodeId,
        state.runId ?? '',
        'decision',
        `${label} review skipped: ${humanReadableError(message)}`,
      );
      return kind === 'qa' ? { qaReview: '' } : { securityReview: '' };
    }
  }

  private formatReview(result: ReviewResult): string {
    const issues = Array.isArray(result.issues)
      ? result.issues.filter((item): item is string => typeof item === 'string')
      : [];
    const verdict =
      result.verdict === 'needs_changes' || issues.length > 0 ? 'NEEDS CHANGES' : 'PASS';
    const recommendations = Array.isArray(result.recommendations)
      ? result.recommendations.filter((item): item is string => typeof item === 'string')
      : [];
    return [
      verdict,
      ...(issues.length ? ['ISSUES', ...issues.map((item) => `- ${item}`)] : []),
      ...(recommendations.length
        ? ['RECOMMENDATIONS', ...recommendations.map((item) => `- ${item}`)]
        : []),
    ].join('\n');
  }
}
