import { Injectable, Logger } from '@nestjs/common';
import { DevFlowStateType, RetryDirective } from '../graph/devflow.state';
import { NODE } from '../graph/topology';
import { MemoryService } from '../../memory/memory.service';
import { StreamEmitter } from '../streaming/stream-emitter.service';
import { humanReadableError } from './human-readable-error';
import { OutputValidationService } from '../output-validation/output-validation.service';
import type { ValidationError, ValidationErrorCode } from '../output-validation/schemas/schema.types';

type AgentType = 'frontend' | 'backend' | 'database' | 'architecture';

interface ValidationResult {
  valid: boolean;
  missingFiles: string[];
  syntaxIssues: string[];
  typeIssues: string[];
  schemaIssues: string[];
  contractIssues: string[];
  /** Cross-artifact integration violations (frontend↔backend↔database). */
  integrationIssues: string[];
  /** Every failing issue grouped under the agent responsible for fixing it. */
  agentIssues: Map<AgentType, string[]>;
}

@Injectable()
export class ValidatorNode {
  private readonly logger = new Logger(ValidatorNode.name);
  private static readonly MAX_RETRIES = 5;

  /**
   * Maps validation error codes to actionable fix suggestions, making retry
   * directives more helpful than just "this is broken."
   */
  private static readonly FIX_SUGGESTIONS: Record<ValidationErrorCode, string> = {
    TS_SYNTAX: 'Fix syntax: check for missing brackets, parens, semicolons, or trailing commas. Run the file through a TS parser before re-emitting.',
    TS_TYPE: 'Fix type error: ensure all imported symbols exist, interfaces match their usage, and generic params satisfy their constraints.',
    SQL_SYNTAX: 'Fix SQL: check keyword spelling, paren matching, and statement terminator placement.',
    MD_SYNTAX: 'Fix markdown: ensure code blocks are fenced with triple backticks and headings have a space after #.',
    SCHEMA_VIOLATION: 'Fix schema: ensure the artifact matches the required shape (file path prefix, content length, exports).',
    BASE: 'Fix base: filePath, displayName, and content are all required with minimum lengths.',
    CONTRACT: 'Fix integration seam: ensure frontend API calls match backend routes and backend Prisma calls match schema models.',
  };

  constructor(
    private readonly memory: MemoryService,
    private readonly streamEmitter: StreamEmitter,
    private readonly outputValidation: OutputValidationService,
  ) {}

  async execute(
    state: DevFlowStateType,
  ): Promise<Partial<DevFlowStateType>> {
    const { projectId, runId } = state;
    this.logger.log(
      `[${projectId}] Validating outputs (attempt ${state.retryCount + 1}/${ValidatorNode.MAX_RETRIES})`,
    );

    if (!state.contract) {
      this.streamEmitter.emit(projectId, NODE.VALIDATE_OUTPUTS, runId ?? '', 'error', 'Validator skipped: contract is missing');
      return { error: 'ValidatorNode: contract is null' };
    }

    try {
      if (process.env.MOCK_MODE === 'true') {
        this.streamEmitter.emit(projectId, NODE.VALIDATE_OUTPUTS, runId ?? '', 'decision', 'Mock mode: returning pass validation');
      }
      this.streamEmitter.progress(projectId, NODE.VALIDATE_OUTPUTS, runId ?? '', 50, 'Checking artifacts');
      const result = this.validate(state);

      if (result.valid) {
        this.logger.log(`[${state.projectId}] Validation passed`);
        this.streamEmitter.emit(projectId, NODE.VALIDATE_OUTPUTS, runId ?? '', 'decision', 'Validation passed: all artifacts meet contract requirements');
        return { retryPlan: [], validationFeedback: null };
      }

      this.logger.warn(
        `[${state.projectId}] Validation failed: missing=${result.missingFiles.length}, syntax=${result.syntaxIssues.length}, type=${result.typeIssues.length}, schema=${result.schemaIssues.length}, integration=${result.integrationIssues.length}, contract=${result.contractIssues.length}`,
      );

      this.streamEmitter.emit(projectId, NODE.VALIDATE_OUTPUTS, runId ?? '', 'decision', `Validation failed: ${result.missingFiles.length} missing files, ${result.syntaxIssues.length} syntax issues, ${result.typeIssues.length} type issues, ${result.schemaIssues.length} schema issues, ${result.integrationIssues.length} integration issues, ${result.contractIssues.length} contract issues`);

      const validationIssueText = [
        ...result.missingFiles.map((f) => `MISSING FILE: ${f}`),
        ...result.syntaxIssues.map((s) => `SYNTAX: ${s} | Fix: ${ValidatorNode.FIX_SUGGESTIONS.TS_SYNTAX}`),
        ...result.typeIssues.map((s) => `TYPE: ${s} | Fix: ${ValidatorNode.FIX_SUGGESTIONS.TS_TYPE}`),
        ...result.schemaIssues.map((s) => `SCHEMA: ${s} | Fix: ${ValidatorNode.FIX_SUGGESTIONS.SCHEMA_VIOLATION}`),
        ...result.integrationIssues.map((s) => `INTEGRATION: ${s} | Fix: ${ValidatorNode.FIX_SUGGESTIONS.CONTRACT}`),
        ...result.contractIssues.map((s) => `CONTRACT: ${s} | Fix: Align acceptance criteria with generated artifacts`),
      ].join('\n');

      // Each failing agent gets feedback scoped to its own issues; this also
      // drives which agents are re-run and which mistakes are remembered.
      const retryPlan = this.buildRetryPlan(
        result,
        validationIssueText,
        state.artifacts,
        state.contract,
      );
      const impliedAgents = retryPlan.map((d) => d.agentType);

      const stackKey = state.stackKey ?? 'unknown';
      await Promise.allSettled(
        retryPlan.map((directive) =>
          this.memory.writeMistake({
            agentType: directive.agentType,
            rejectedContent: directive.feedback,
            rejectionNotes: `Validator rejected ${directive.agentType} output at retry ${state.retryCount}: ${directive.feedback.slice(0, 300)}`,
            projectId: state.projectId,
            gateType: 'GATE_2',
            stackKey,
            sourceType: 'validator_failure',
            approvalSource: 'VALIDATOR',
          }),
        ),
      );

      if (state.retryCount < ValidatorNode.MAX_RETRIES - 1) {
        const nextRetry = state.retryCount + 1;
        this.logger.log(
          `[${state.projectId}] Scheduling retry ${nextRetry} for agents: ${impliedAgents.join(', ') || 'frontend'}`,
        );
        return {
          retryCount: nextRetry,
          retryPlan,
          error: null,
        };
      }

      this.logger.warn(
        `[${state.projectId}] Max retries reached, proceeding with partial validation`,
      );
      return {
        error: `Validation exceeded max retries. Issues: ${[
          ...result.missingFiles.map((f) => `missing:${f}`),
          ...result.syntaxIssues,
          ...result.typeIssues,
          ...result.schemaIssues,
          ...result.integrationIssues,
          ...result.contractIssues,
        ].join('; ')}`,
        retryPlan: [],
        retryCount: state.retryCount,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${state.projectId}] Validator failed: ${message}`);
      this.streamEmitter.emit(projectId, NODE.VALIDATE_OUTPUTS, runId ?? '', 'error', `Validation failed: ${humanReadableError(message)}`);
      return { error: `ValidatorNode failed: ${message}` };
    }
  }

  private validate(state: DevFlowStateType): ValidationResult {
    if (process.env.MOCK_MODE === 'true') {
      return {
        valid: true,
        missingFiles: [],
        syntaxIssues: [],
        typeIssues: [],
        schemaIssues: [],
        contractIssues: [],
        integrationIssues: [],
        agentIssues: new Map(),
      };
    }

    const contract = state.contract!;
    const generatedPaths = new Set(state.artifacts.map((a) => a.filePath));

    const missingFiles = contract.fileManifest.filter(
      (f) => !generatedPaths.has(f),
    );

    // Run real syntax + type-aware checks via OutputValidationService
    const validationErrors = this.outputValidation.validateBatch(
      state.artifacts,
      state.projectId,
      { designGuidance: state.designGuidance },
    );
    const syntaxIssues = validationErrors
      .filter((e) => e.code === 'TS_SYNTAX' || e.code === 'SQL_SYNTAX' || e.code === 'MD_SYNTAX')
      .map((e) => e.message);
    const typeIssues = validationErrors
      .filter((e) => e.code === 'TS_TYPE')
      .map((e) => `${e.path ? `${e.path}: ` : ''}${e.message}`);
    const schemaIssues = validationErrors
      .filter((e) => e.code === 'SCHEMA_VIOLATION' || e.code === 'BASE')
      .map((e) => `${e.path ? `${e.path}: ` : ''}${e.message}`);
    const integrationIssues = validationErrors
      .filter((e) => e.code === 'CONTRACT')
      .map((e) => `${e.path ? `${e.path}: ` : ''}${e.message}`);

    const contractIssues: string[] = [];
    if (contract.acceptanceCriteria.length > 0) {
      contractIssues.push(...this.checkAcceptanceCriteria(state));
    }

    const valid =
      missingFiles.length === 0 &&
      syntaxIssues.length === 0 &&
      typeIssues.length === 0 &&
      schemaIssues.length === 0 &&
      integrationIssues.length === 0 &&
      contractIssues.length === 0;

    const agentIssues = valid
      ? new Map<AgentType, string[]>()
      : this.groupIssuesByAgent(validationErrors, missingFiles, contractIssues);

    return { valid, missingFiles, syntaxIssues, typeIssues, schemaIssues, contractIssues, integrationIssues, agentIssues };
  }

  /**
   * Builds one retry directive per failing agent, each carrying feedback scoped
   * to that agent's own issues, so a parallel fan-out re-runs exactly the agents
   * that failed. Includes the actual artifact content that failed and relevant
   * acceptance criteria so the LLM can see what it generated and what needs to
   * change. Falls back to a single frontend directive carrying the full issue
   * text if nothing could be attributed.
   */
  private buildRetryPlan(
    result: ValidationResult,
    fallbackFeedback: string,
    artifacts: Array<{ agentType: string; filePath: string; content: string }>,
    contract: { acceptanceCriteria: string[] } | null,
  ): RetryDirective[] {
    const plan: RetryDirective[] = [];

    for (const [agentType, issues] of result.agentIssues) {
      // Get the failing artifacts for this agent
      const agentArtifacts = artifacts
        .filter((a) => a.agentType === agentType)
        .slice(0, 3)
        .map((a) => {
          const excerpt = a.content.slice(0, 1000);
          return `--- ${a.filePath} (current output, ${a.content.length} chars) ---\n${excerpt}${a.content.length > 1000 ? '\n...(truncated)' : ''}`;
        })
        .join('\n\n');

      // Get relevant acceptance criteria for this agent type
      const relevantCriteria = (contract?.acceptanceCriteria ?? [])
        .filter((c) => {
          const lower = c.toLowerCase();
          if (agentType === 'frontend') return lower.includes('frontend') || lower.includes('ui') || lower.includes('component') || lower.includes('page');
          if (agentType === 'backend') return lower.includes('api') || lower.includes('endpoint') || lower.includes('route') || lower.includes('backend');
          if (agentType === 'database') return lower.includes('database') || lower.includes('schema') || lower.includes('model') || lower.includes('table');
          if (agentType === 'architecture') return lower.includes('documentation') || lower.includes('readme') || lower.includes('architecture');
          return false;
        })
        .map((c) => `- ${c}`);

      const feedbackParts = [
        `RETRY SCOPE: ${agentType} agent only. Fix the issues below without changing unrelated agent outputs.`,
        'MUST FIX:',
        ...issues.map((i) => `- ${i}`),
        '',
        'RULES FOR THIS RETRY:',
        '- Return complete replacement artifact content, not patches or summaries.',
        '- Preserve working file paths, public names, DTO fields, routes, and model names unless the issue explicitly requires a rename.',
        '- Do not emit scaffolded files such as package.json, tsconfig files, next/postcss config, nest-cli.json, lockfiles, or linter config.',
        '- Remove placeholders, TODOs, stub text, example.com, lorem ipsum, and unfinished ellipses.',
      ];

      if (relevantCriteria.length > 0) {
        feedbackParts.push('', 'RELEVANT ACCEPTANCE CRITERIA (your output must satisfy these):', ...relevantCriteria);
      }

      if (agentArtifacts) {
        feedbackParts.push('', 'YOUR CURRENT OUTPUT (fix this, do not regenerate from scratch):', agentArtifacts);
      }

      plan.push({ agentType, feedback: feedbackParts.join('\n') });
    }

    if (plan.length === 0) {
      plan.push({ agentType: 'frontend', feedback: fallbackFeedback });
    }
    return plan;
  }

  /**
   * Groups every validation issue under the agent responsible for fixing it so
   * each retried agent receives feedback about only its own failures:
   *  - content errors (syntax/type/schema/base) use the agentType stamped on the
   *    error during batch validation (falling back to the file path);
   *  - missing files are attributed by file extension;
   *  - contract issues are attributed from their "<agent>: ..." prefix.
   */
  private groupIssuesByAgent(
    validationErrors: ValidationError[],
    missingFiles: string[],
    contractIssues: string[],
  ): Map<AgentType, string[]> {
    const grouped = new Map<AgentType, string[]>();
    const add = (agent: AgentType, text: string): void => {
      const list = grouped.get(agent);
      if (list) list.push(text);
      else grouped.set(agent, [text]);
    };

    for (const error of validationErrors) {
      const agent = error.agentType ?? this.agentForFile(error.path ?? '');
      add(agent, `${this.labelFor(error.code)}: ${error.path ? `${error.path}: ` : ''}${error.message}`);
    }

    for (const file of missingFiles) {
      add(this.agentForFile(file), `MISSING FILE: ${file}`);
    }

    for (const issue of contractIssues) {
      add(this.agentFromContractIssue(issue), `CONTRACT: ${issue}`);
    }

    return grouped;
  }

  private labelFor(code: ValidationError['code']): string {
    if (code === 'TS_TYPE') return 'TYPE';
    if (code === 'TS_SYNTAX' || code === 'SQL_SYNTAX' || code === 'MD_SYNTAX') return 'SYNTAX';
    if (code === 'CONTRACT') return 'INTEGRATION';
    return 'SCHEMA';
  }

  /** Best-effort agent attribution from a file path's extension/suffix. */
  private agentForFile(filePath: string): AgentType {
    if (/\.(tsx|jsx|css)$/.test(filePath)) return 'frontend';
    if (/\.(module|controller|service|guard|pipe|interceptor|dto)\.ts$/.test(filePath)) return 'backend';
    if (/\.(prisma|sql)$/.test(filePath)) return 'database';
    if (/\.md$/.test(filePath)) return 'architecture';
    return 'backend';
  }

  /** Contract issues are emitted prefixed with "<agent>: ..."; parse the agent. */
  private agentFromContractIssue(issue: string): AgentType {
    const prefix = issue.split(':', 1)[0]?.trim().toLowerCase();
    if (
      prefix === 'frontend' ||
      prefix === 'backend' ||
      prefix === 'database' ||
      prefix === 'architecture'
    ) {
      return prefix;
    }
    return 'frontend';
  }

  private checkAcceptanceCriteria(state: DevFlowStateType): string[] {
    const issues: string[] = [];
    const contract = state.contract!;

    for (const criterion of contract.acceptanceCriteria) {
      const lower = criterion.toLowerCase();

      if (lower.includes('frontend') || lower.includes('ui') || lower.includes('component') || lower.includes('page')) {
        const frontendArtifacts = state.artifacts.filter((a) => a.agentType === 'frontend');
        const hasMeaningful = frontendArtifacts.some((a) => a.content.trim().length > 100);
        const fileCount = frontendArtifacts.length;
        if (!hasMeaningful) {
          issues.push(`frontend: acceptance criterion "${criterion}" — no meaningful frontend artifacts (${fileCount} files, none >100 chars)`);
        }
      }

      if (lower.includes('api') || lower.includes('endpoint') || lower.includes('route') || lower.includes('backend')) {
        const backendArtifacts = state.artifacts.filter((a) => a.agentType === 'backend');
        const hasController = backendArtifacts.some((a) => a.content.includes('@Controller') || a.content.includes('@Resolver'));
        const hasService = backendArtifacts.some((a) => a.content.includes('@Injectable'));
        if (!hasController) {
          issues.push(`backend: acceptance criterion "${criterion}" — no controller found (expected @Controller decorator)`);
        }
        if (!hasService) {
          issues.push(`backend: acceptance criterion "${criterion}" — no service found (expected @Injectable)`);
        }
      }

      if (lower.includes('database') || lower.includes('schema') || lower.includes('model') || lower.includes('table')) {
        const hasPrismaSchema = state.artifacts.some(
          (a) => a.filePath.endsWith('schema.prisma') && a.content.trim().length > 100,
        );
        const hasMigration = state.artifacts.some(
          (a) => a.filePath.endsWith('.sql') && /CREATE\s+TABLE/i.test(a.content),
        );
        if (!hasPrismaSchema) {
          issues.push(`database: acceptance criterion "${criterion}" — no Prisma schema file`);
        }
        if (!hasMigration) {
          issues.push(`database: acceptance criterion "${criterion}" — no SQL migration with CREATE TABLE`);
        }
      }

      if (lower.includes('documentation') || lower.includes('readme') || lower.includes('architecture') || lower.includes('docs')) {
        const docFiles = state.artifacts.filter((a) => a.filePath.endsWith('.md'));
        const hasArchitecture = docFiles.some((a) => a.filePath.includes('ARCHITECTURE'));
        const hasApi = docFiles.some((a) => a.filePath.includes('API'));
        const hasDeployment = docFiles.some((a) => a.filePath.includes('DEPLOYMENT'));
        if (!hasArchitecture) issues.push(`architecture: acceptance criterion "${criterion}" — missing ARCHITECTURE.md`);
        if (!hasApi) issues.push(`architecture: acceptance criterion "${criterion}" — missing API.md`);
        if (!hasDeployment) issues.push(`architecture: acceptance criterion "${criterion}" — missing DEPLOYMENT.md`);
      }
    }

    return issues;
  }
}
