import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MemoryService } from '../../memory/memory.service';
import {
  DevFlowStateType,
  RequirementsDocument,
} from '../graph/devflow.state';
import { NODE } from '../graph/topology';
import { AgentLlmRouter } from '../providers/agent-llm.router';
import { StreamEmitter } from '../streaming/stream-emitter.service';
import { humanReadableError } from './human-readable-error';
import { REQUIREMENTS_PARSER_INTAKE_RULES, REQUIREMENTS_PARSER_SYSTEM } from '../prompts/agent-prompts';
import { resolveModelForNode } from '../providers/base-llm.provider';

// ─── Node ─────────────────────────────────────────────────────────────────────

@Injectable()
export class RequirementsParserNode {
  private readonly logger = new Logger(RequirementsParserNode.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
    private readonly llm: AgentLlmRouter,
    private readonly streamEmitter: StreamEmitter,
  ) {}

  async execute(
    state: DevFlowStateType,
  ): Promise<Partial<DevFlowStateType>> {
    const { projectId, runId } = state;
    this.logger.log(`[${projectId}] Parsing requirements`);

    this.streamEmitter.emit(projectId, NODE.PARSE_REQUIREMENTS, runId ?? '', 'decision', 'Analyzing project brief to extract structured requirements...');
    this.streamEmitter.progress(projectId, NODE.PARSE_REQUIREMENTS, runId ?? '', 10, 'Analyzing brief');

    try {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { status: 'PARSING_REQUIREMENTS' },
      });

      this.streamEmitter.emit(projectId, NODE.PARSE_REQUIREMENTS, runId ?? '', 'decision', `Reading project memories for stack key "${state.stackKey}"`);

      // Fetch layered memory context so the parser can learn from past
      // requirements parses, patterns, and mistakes for similar projects.
      const memoryQuery = [
        state.stackKey,
        state.brief?.slice(0, 200),
        'requirements parsing',
      ].filter(Boolean).join(' ');

      const memoryBundle = await this.memory.buildContextForAgent({
        agentType: 'requirements',
        projectId: state.projectId,
        query: memoryQuery,
      });

      const intakeBlock = state.intakeContext
        ? `Locked Client Intake (authoritative; do not invent beyond this package):\n${JSON.stringify(state.intakeContext, null, 2)}`
        : 'No locked client intake package is available. Use the project brief and label any inferred assumptions.';

      const prompt = `You are a software architect analyzing a project brief to extract structured requirements.

Project Brief:
${state.brief}

Preferred Stack Key: ${state.stackKey}

Analyze this brief and produce a structured requirements document. Base the tech stack on the stack key hint, but infer reasonable defaults if not specified.

${REQUIREMENTS_PARSER_INTAKE_RULES}

${intakeBlock}

${memoryBundle.context ? `Context from similar past requirements:\n${memoryBundle.context}` : ''}`;

      // Mock Mode bypass
      if (process.env.MOCK_MODE === 'true') {
        const requirements: RequirementsDocument = {
          projectType: 'SaaS Dashboard',
          features: ['User Auth', 'Payments', 'Dashboard'],
          techStack: {
            frontend: 'Next.js',
            backend: 'NestJS',
            database: 'PostgreSQL',
            styling: 'Tailwind'
          },
          complexity: 'simple',
          estimatedFiles: 5,
          assumptions: [],
          openQuestions: [],
          evidence: [],
        };
        this.streamEmitter.emit(projectId, NODE.PARSE_REQUIREMENTS, runId ?? '', 'decision', 'Mock mode: returning predefined requirements');
        return { requirements, complexity: 'simple', requirementsAssumptions: [], openQuestions: [], requirementsEvidence: [] };
      }

      this.streamEmitter.emit(projectId, NODE.PARSE_REQUIREMENTS, runId ?? '', 'decision', `Calling LLM (${this.llm.model()}) to parse requirements...`);
      this.streamEmitter.progress(projectId, NODE.PARSE_REQUIREMENTS, runId ?? '', 35, 'Calling LLM');

      const result = await this.llm.generateJson<Partial<RequirementsDocument>>({
        agentName: resolveModelForNode('parse_requirements', 'requirements_parser'),
        subagent: 'requirements-parser',
        correlation: {
          projectId,
          runId,
          nodeId: NODE.PARSE_REQUIREMENTS,
          agent: 'requirements-parser',
        },
        onToken: (delta) => this.streamEmitter.emit(projectId, NODE.PARSE_REQUIREMENTS, runId ?? '', 'token', delta),
        systemPrompt: REQUIREMENTS_PARSER_SYSTEM,
        userPrompt: prompt,
        expectedShape: 'object',
      });

      const parsed = result.value;
      const features = Array.isArray(parsed.features) && parsed.features.length > 0
        ? parsed.features.filter((feature): feature is string => typeof feature === 'string')
        : ['Core application workflow'];
      const techStack = parsed.techStack && typeof parsed.techStack === 'object'
        ? parsed.techStack
        : {
            frontend: 'Next.js',
            backend: 'NestJS',
            database: 'PostgreSQL',
            styling: 'Tailwind CSS',
          };
      const parsedComplexity = parsed.complexity === 'simple' || parsed.complexity === 'medium' || parsed.complexity === 'complex'
        ? parsed.complexity
        : 'medium';

      const assumptions = Array.isArray(parsed.assumptions)
        ? parsed.assumptions.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      const openQuestions = Array.isArray(parsed.openQuestions)
        ? parsed.openQuestions.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      // Shape-checking evidence is not enough: a model can emit a well-formed citation for a
      // document that was never supplied. Anything that does not resolve to a real source in the
      // locked intake package is dropped here, so downstream gates only ever see citations that
      // point at text an agent actually received.
      const suppliedDocumentIds = new Set(
        (state.intakeContext?.sources ?? []).map((source) => source.documentId),
      );
      const citedEvidence = Array.isArray(parsed.evidence)
        ? parsed.evidence
          .filter((item): item is { documentId: string; locator?: string; supports: string } => Boolean(
            item && typeof item === 'object' && typeof (item as { documentId?: unknown }).documentId === 'string' && typeof (item as { supports?: unknown }).supports === 'string',
          ))
          .map((item) => ({ documentId: item.documentId, locator: typeof item.locator === 'string' ? item.locator : undefined, supports: item.supports }))
        : [];
      const evidence = citedEvidence.filter((item) => suppliedDocumentIds.has(item.documentId));
      const unresolvedCitations = citedEvidence.length - evidence.length;
      if (unresolvedCitations > 0) {
        this.logger.warn(
          `[${state.projectId}] Dropped ${unresolvedCitations} requirement citation(s) referencing documents that were not supplied`,
        );
        this.streamEmitter.emit(
          projectId,
          NODE.PARSE_REQUIREMENTS,
          runId ?? '',
          'decision',
          `Discarded ${unresolvedCitations} citation(s) that did not match a supplied document`,
        );
      }
      const requirements: RequirementsDocument = {
        projectType: typeof parsed.projectType === 'string' ? parsed.projectType : 'Custom web application',
        features,
        techStack: {
          frontend: typeof techStack.frontend === 'string' ? techStack.frontend : 'Next.js',
          backend: typeof techStack.backend === 'string' ? techStack.backend : 'NestJS',
          database: typeof techStack.database === 'string' ? techStack.database : 'PostgreSQL',
          styling: typeof techStack.styling === 'string' ? techStack.styling : 'Tailwind CSS',
        },
        complexity: parsedComplexity,
        estimatedFiles: typeof parsed.estimatedFiles === 'number' && parsed.estimatedFiles > 0
          ? Math.ceil(parsed.estimatedFiles)
          : features.length + 6,
        assumptions,
        openQuestions,
        evidence,
      };

      this.logger.log(
        `[${state.projectId}] Requirements parsed: ${requirements.complexity} complexity, ${requirements.estimatedFiles} estimated files`,
      );

      // ── Derive top-level complexity for Phase 2D parallel fan-out ────────────
      // The graph router reads state.complexity to decide whether to dispatch
      // frontend/backend/database/architecture agents in parallel (Send() API)
      // or keep them sequential. Thresholds:
      //   complex  — > 5 features OR > 10 estimated files
      //   medium   — > 3 features OR > 5 estimated files
      //   simple   — otherwise
      let complexity: 'simple' | 'medium' | 'complex';
      if (requirements.features.length > 5 || requirements.estimatedFiles > 10) {
        complexity = 'complex';
      } else if (requirements.features.length > 3 || requirements.estimatedFiles > 5) {
        complexity = 'medium';
      } else {
        complexity = 'simple';
      }

      // ── Write successful parse as a SKILL for the 'requirements' agent ────────
      // This builds the memory store's understanding of how briefs map to parsed
      // requirements for a given stack + project type. Future runs can reference
      // these entries to self-correct their own parsing output.
      this.streamEmitter.progress(projectId, NODE.PARSE_REQUIREMENTS, runId ?? '', 85, 'Saving requirements');
      this.streamEmitter.emit(projectId, NODE.PARSE_REQUIREMENTS, runId ?? '', 'tool-call', 'Writing requirements to memory store', { operation: 'writeSkill', agentType: 'requirements' });

      await this.memory.writeSkill({
        agentType: 'requirements',
        systemPrompt: prompt,
        artifactContent: JSON.stringify(requirements, null, 2),
        filePath: `requirements/${projectId}.json`,
        projectId,
        stackKey: state.stackKey,
        projectType: requirements.projectType,
      });

      this.streamEmitter.emit(projectId, NODE.PARSE_REQUIREMENTS, runId ?? '', 'decision', `Requirements parsed: ${requirements.complexity} complexity, ${requirements.estimatedFiles} estimated files, ${requirements.features.length} features`);

      return { requirements, complexity, requirementsAssumptions: assumptions, openQuestions, requirementsEvidence: evidence };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${projectId}] Requirements parsing failed: ${message}`);

      this.streamEmitter.emit(projectId, NODE.PARSE_REQUIREMENTS, runId ?? '', 'error', `Requirements parsing failed: ${humanReadableError(message)}`);

      await this.prisma.project
        .update({
          where: { id: projectId },
          data: { status: 'FAILED' },
        })
        .catch(() => undefined);

      return { error: `RequirementsParserNode failed: ${message}` };
    }
  }
}


