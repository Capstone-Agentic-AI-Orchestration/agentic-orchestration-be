import { Injectable, Optional } from '@nestjs/common';
import { WorkOrderAgentType } from '@prisma/client';
import { MemoryService } from '../../memory/memory.service';
import {
  GeneratedWorkOrderOutput,
  WorkOrderAgentContext,
  WorkOrderAgentProvider,
} from './agent-provider.types';
import {
  agentArtifactContractFor,
  ORCHESTRATION_CONTRACT_VERSION,
} from './agent-contracts';
import {
  BaseLlmProvider,
  type LlmUsage,
} from './base-llm.provider';
import {
  selectedLlmProvider,
  type LlmProviderName,
} from './llm-runtime';
import { QUALITY_BAR } from '../prompts/agent-prompts';
import {
  type AgentSkillRole,
  renderAgentSkillPack,
} from '../prompts/agent-skill-registry';

@Injectable()
export class LlmAgentProvider extends BaseLlmProvider implements WorkOrderAgentProvider {
  readonly mode = 'llm' as const;

  constructor(@Optional() private readonly memory?: MemoryService) {
    super();
  }

  providerName(): LlmProviderName {
    return selectedLlmProvider();
  }

  missingRequirements(): string[] {
    if (this.providerName() === 'anthropic') {
      return process.env.ANTHROPIC_API_KEY?.trim() ? [] : ['ANTHROPIC_API_KEY'];
    }
    if (this.providerName() === 'openai') {
      return process.env.OPENAI_API_KEY?.trim() ? [] : ['OPENAI_API_KEY'];
    }
    if (this.providerName() === 'opencode') {
      return process.env.OPENCODE_API_KEY?.trim() ? [] : ['OPENCODE_API_KEY'];
    }
    if (this.providerName() === 'gemini') {
      return process.env.GEMINI_API_KEY?.trim() ? [] : ['GEMINI_API_KEY'];
    }
    return process.env.OPENROUTER_API_KEY?.trim() ? [] : ['OPENROUTER_API_KEY'];
  }

  unavailableReason(): string | null {
    const missing = this.missingRequirements();
    if (missing.length === 0) return null;
    return `${this.providerLabel()} provider requires ${missing.join(' and ')}.`;
  }

  async generateWorkOrderOutput(
    context: WorkOrderAgentContext,
  ): Promise<GeneratedWorkOrderOutput> {
    const missing = this.missingRequirements();
    if (missing.length > 0) {
      throw new Error(`${this.providerLabel()} provider is unavailable: missing ${missing.join(', ')}`);
    }

    const memoryContext = await this.workOrderMemoryContext(context);
    const contract = agentArtifactContractFor(context.workOrder.agentType);
    const skillPack = renderAgentSkillPack(
      this.skillRoleForWorkOrder(context.workOrder.agentType),
    );

    const systemPrompt = [
      'You are a senior DevFlow implementation engineer producing one real, production-ready project file from a work order.',
      'Return one strict JSON object only. Do not include markdown fences or commentary.',
      'The JSON schema is:',
      '{"filePath":"string","displayName":"string","language":"string","content":"string","metadata":{}}',
      'The content field must contain the COMPLETE generated file as a string — a real, working implementation, never a summary, outline, or stub.',
      `filePath must start with work-orders/${context.workOrder.id}/`,
      `filePath must end with one of: ${contract.requiredExtensions.join(', ')}`,
      `language must be ${contract.language}.`,
      `At minimum the content must include ${contract.requiredSignals
        .map((signal) => signal.anyOf.map((value) => `"${value}"`).join(' or '))
        .join('; ')} — but treat these only as a floor and deliver substantially more complete, well-structured work than the minimum.`,
      skillPack,
      this.agentInstruction(context.workOrder.agentType),
      QUALITY_BAR,
      memoryContext ? `Relevant layered memory:\n${memoryContext}` : null,
    ].filter(Boolean).join('\n');

    const userPrompt = JSON.stringify({
      project: context.project,
      workOrder: context.workOrder,
      task: context.task,
      sourceArtifact: context.sourceArtifact
        ? {
            filePath: context.sourceArtifact.filePath,
            displayName: context.sourceArtifact.displayName,
            content: context.sourceArtifact.content.slice(0, 12000),
          }
        : null,
      executionRunId: context.executionRunId,
      outputContract: {
        version: ORCHESTRATION_CONTRACT_VERSION,
        filePath: `work-orders/${context.workOrder.id}/${contract.fileName}`,
        displayName: `${context.workOrder.title} output`,
        language: contract.language,
        handoffChecklist: contract.handoffChecklist,
      },
    });

    const result = await this.fetchWithFallback<Record<string, unknown>>(
      {
        agentName: 'work_order_output',
        systemPrompt,
        userPrompt,
        expectedShape: 'object',
        onToken: context.onToken,
      },
      (content) => this.parseOutputToObject(content),
    );

    return this.buildOutput(result.value, context, result.model, result.usage);
  }

  private async workOrderMemoryContext(context: WorkOrderAgentContext): Promise<string> {
    if (!this.memory) return '';

    const query = [
      context.project.companyName,
      context.project.stackKey,
      context.project.brief,
      context.workOrder.title,
      context.workOrder.instructions,
      context.task?.title,
      context.task?.description,
      context.sourceArtifact?.filePath,
      context.sourceArtifact?.displayName,
    ]
      .filter(Boolean)
      .join(' ');

    const bundle = await this.memory.buildContextForAgent({
      agentType: context.workOrder.agentType.toLowerCase(),
      projectId: context.project.id,
      query,
      topK: 2,
    });

    return bundle.context;
  }

  private skillRoleForWorkOrder(
    agentType: WorkOrderAgentType,
  ): AgentSkillRole | undefined {
    switch (agentType) {
      case WorkOrderAgentType.CONTRACT:
        return 'contract';
      case WorkOrderAgentType.FRONTEND:
        return 'frontend';
      case WorkOrderAgentType.BACKEND:
        return 'backend';
      case WorkOrderAgentType.DATABASE:
        return 'database';
      case WorkOrderAgentType.ARCHITECTURE:
        return 'architecture';
      default:
        return undefined;
    }
  }

  private agentInstruction(agentType: WorkOrderAgentType): string {
    switch (agentType) {
      case WorkOrderAgentType.FRONTEND:
        return [
          'Generate a complete, typed React/Next.js component that fulfils the work order.',
          'Export a named component (export function), use semantic, accessible JSX, and implement real loading/empty/error states where data is involved.',
          'Derive props, copy, and structure from the work order — do not emit a placeholder shell.',
        ].join(' ');
      case WorkOrderAgentType.BACKEND:
        return [
          'Generate a complete, typed NestJS service or controller fulfilling the work order.',
          'Use proper decorators (@Injectable/@Controller), constructor dependency injection, validated input, real method bodies, and explicit error handling with correct HTTP status codes.',
        ].join(' ');
      case WorkOrderAgentType.DATABASE:
        return [
          'Generate clean SQL DDL fulfilling the work order: CREATE TABLE / ALTER TABLE with semicolon terminators.',
          'Use correct column types, nullability, defaults, primary/foreign keys with cascade rules, and indexes matching realistic query patterns.',
        ].join(' ');
      case WorkOrderAgentType.ARCHITECTURE:
        return 'Generate detailed markdown with # / ## sections, an Objective, and Delivery Notes, specific to this project (real features, stack, and components — not boilerplate).';
      case WorkOrderAgentType.CONTRACT:
        return 'Generate detailed markdown with explicit Scope and an actionable Acceptance Checklist of verifiable, testable criteria derived from the work order.';
      default:
        return 'Generate a complete, production-ready implementation artifact that fully satisfies the output contract.';
    }
  }

  private parseOutputToObject(content: string): Record<string, unknown> {
    const jsonText = this.extractJson(content, 'object');
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (error) {
      throw new Error(`${this.providerLabel()} returned invalid JSON: ${this.errorMessage(error)}`);
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`${this.providerLabel()} response must be a JSON object.`);
    }

    const record = this.outputRecordFrom(parsed);
    return record;
  }

  private outputRecordFrom(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${this.providerLabel()} response must be a JSON object.`);
    }

    const record = value as Record<string, unknown>;
    if (
      this.stringField(record, ['filePath', 'file_path', 'path']) ||
      this.stringField(record, ['content', 'code', 'source', 'body'])
    ) {
      return record;
    }

    for (const key of ['artifact', 'output', 'result', 'file', 'data']) {
      const nested = record[key];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        return this.outputRecordFrom(nested);
      }
    }

    return record;
  }

  private stringField(record: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
    }
    return null;
  }

  private buildOutput(
    record: Record<string, unknown>,
    context: WorkOrderAgentContext,
    model: string,
    usage: LlmUsage,
  ): GeneratedWorkOrderOutput {
    const filePath = this.stringField(record, ['filePath', 'file_path', 'path']);
    const displayName = this.stringField(record, ['displayName', 'display_name', 'name', 'title'])
      ?? (filePath ? filePath.split('/').pop() : null);
    const language = this.stringField(record, ['language', 'lang'])
      ?? this.languageFromFilePath(filePath);
    const generatedContent = this.stringField(record, ['content', 'code', 'source', 'body']);

    if (!filePath || !displayName || !language || !generatedContent) {
      throw new Error(
        `${this.providerLabel()} ${model} response must include string filePath, displayName, language, and content fields.`,
      );
    }

    const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? record.metadata as Record<string, unknown>
      : {};

    return {
      filePath,
      displayName,
      language,
      content: generatedContent,
      metadata: {
        ...metadata,
        providerMode: this.mode,
        provider: this.providerName(),
        model,
        contractVersion: ORCHESTRATION_CONTRACT_VERSION,
        agentType: context.workOrder.agentType,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
      },
    };
  }

  private languageFromFilePath(filePath: string | null): string | null {
    if (!filePath) return null;
    if (filePath.endsWith('.sql')) return 'sql';
    if (filePath.endsWith('.md')) return 'markdown';
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts')) {
      return 'typescript';
    }
    return null;
  }
}
