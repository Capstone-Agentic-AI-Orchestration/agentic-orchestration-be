import { Injectable } from '@nestjs/common';
import { RetrievedContextItem, RagRetrieveInput } from './rag.types';

@Injectable()
export class ContextRankerService {
  rank(items: RetrievedContextItem[], input: RagRetrieveInput): RetrievedContextItem[] {
    const now = Date.now();
    const agent = this.normalise(input.agentName);
    return items
      .filter((item) => item.projectId === input.projectId && !item.isSuperseded)
      .map((item) => {
        const breakdown = { ...item.scoreBreakdown };
        const keywordScore = Math.min(15, (breakdown.keywordScore ?? 0) * 15);
        const vectorScore = Math.min(40, Math.max(0, breakdown.vectorScore ?? 0) * 40);
        const runScore = input.runId && item.runId === input.runId ? 30 : 0;
        const workOrderScore = input.workOrderId && item.workOrderId === input.workOrderId ? 25 : 0;
        const executionScore = input.workOrderExecutionId && item.workOrderExecutionId === input.workOrderExecutionId ? 25 : 0;
        const agentScore = item.agentName && this.normalise(item.agentName) === agent ? 15 : item.agentName ? -10 : 0;
        const importanceScore = Math.max(1, Math.min(10, item.importance));
        const ageDays = item.createdAt ? Math.max(0, (now - new Date(item.createdAt).getTime()) / 86_400_000) : 90;
        const recencyScore = Math.max(1, Math.round(20 * Math.exp(-ageDays / 30)));
        const sourceTrustScore = this.sourceTrust(item.sourceType);
        const artifactRelevanceScore = item.sourceType === 'artifact' ? 10 : 0;
        const errorFixRelevanceScore = ['error', 'fix'].includes(item.sourceType) ? 12 : 0;
        const score = keywordScore + vectorScore + runScore + workOrderScore + executionScore
          + agentScore + importanceScore + recencyScore + sourceTrustScore
          + artifactRelevanceScore + errorFixRelevanceScore;

        return {
          ...item,
          score,
          scoreBreakdown: {
            ...breakdown,
            keywordScore,
            vectorScore,
            runRelevanceScore: runScore,
            workOrderRelevanceScore: workOrderScore,
            executionRelevanceScore: executionScore,
            agentRelevanceScore: agentScore,
            importanceScore,
            recencyScore,
            sourceTrustScore,
            artifactRelevanceScore,
            errorFixRelevanceScore,
          },
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  private normalise(value: string): string {
    return value.toLowerCase().replace(/[_\s-]+/g, '');
  }

  private sourceTrust(sourceType: string): number {
    if (['project', 'architecture_decision', 'work_order'].includes(sourceType)) return 10;
    if (['artifact', 'fix', 'agent_memory', 'handoff'].includes(sourceType)) return 8;
    if (['error', 'work_order_execution', 'project_task'].includes(sourceType)) return 7;
    if (sourceType === 'event_log') return 4;
    return 5;
  }
}
