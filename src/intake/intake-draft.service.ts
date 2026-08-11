import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DocumentExtractionStatus } from '@prisma/client';
import { AgentLlmRouter } from '../orchestration/providers/agent-llm.router';
import { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { projectAccessWhere } from './intake.service';
import {
  emptyClientIntakePayload,
  type ClientIntakePayload,
  type IntakeDraftProvenance,
  type IntakeDraftResult,
  type IntakeFieldOrigin,
} from './intake.types';

/**
 * How much extracted document text to hand the model. Well under the context limit on purpose:
 * requirements live in the opening pages of a brief or deck, and the tail is usually appendices
 * and boilerplate that dilute the signal.
 */
const MAX_SOURCE_CHARS = 24_000;
const MAX_CHARS_PER_DOCUMENT = 8_000;

const DRAFT_SYSTEM_PROMPT = `You turn a client's own documents into a structured requirements draft.

You are drafting FOR a client to correct, not writing requirements yourself. Two rules matter more
than completeness:

1. NEVER invent a fact. If a document does not say who signs off, leave the approver empty. An empty
   field costs the client ten seconds to fill. A confidently wrong one survives into a locked scope
   that agents treat as authoritative and build from.
2. Mark where every value came from. "stated" means the source says it almost verbatim. "inferred"
   means you concluded it from what the source says. Anything you cannot support from a source must
   be left empty and NOT marked at all.

Write in the client's own words wherever you can. Do not translate their vocabulary into analyst
jargon — if they say "booking", do not write "reservation entity".

Acceptance criteria, business rules, decision points and error cases are the fields clients are
least able to write themselves, so they are the most valuable to draft. They are also the easiest to
fabricate. Only produce them where the source genuinely implies them, and mark them "inferred".`;

/**
 * Drafts a requirements payload from what the client already has.
 *
 * The intake form asks a client for ~24 structured answers before anything can be locked, which is
 * a lot of analyst work to demand from someone who just wants software built. Most of it is already
 * sitting in a brief, a deck or a process document they wrote long before they met us. This reads
 * those, drafts the payload, and leaves the client correcting a draft instead of facing blank
 * fields.
 *
 * It never writes to the intake itself. The caller decides whether to keep the draft, so a bad
 * suggestion is discarded rather than something the client has to undo.
 */
@Injectable()
export class IntakeDraftService {
  private readonly logger = new Logger(IntakeDraftService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: AgentLlmRouter,
  ) {}

  async draftFromSources(projectId: string, user: AuthUser): Promise<IntakeDraftResult> {
    // Same access rule as every other intake route. The project id arrives in the URL, so without
    // this a client could draft — and read document text — from someone else's project.
    const project = await this.prisma.project.findFirst({
      where: projectAccessWhere(user, projectId),
      select: { id: true, companyName: true, brief: true },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    const sources = await this.readableSources(projectId);

    // The brief alone is thin, but it is never nothing: it is what the client wrote when they first
    // got in touch. Refusing to draft without uploads would deny the feature to exactly the clients
    // who have no documents to give — the ones this is meant to help most.
    if (!sources.length && !project.brief.trim()) {
      throw new BadRequestException(
        'Nothing to draft from yet. Upload a document, or add a project brief, and try again.',
      );
    }

    const prompt = this.buildPrompt(project, sources);

    let raw: Partial<ClientIntakePayload> & { provenance?: unknown };
    try {
      const result = await this.llm.generateJson<Partial<ClientIntakePayload> & { provenance?: unknown }>({
        agentName: 'intake-draft',
        subagent: 'requirements-parser',
        systemPrompt: DRAFT_SYSTEM_PROMPT,
        userPrompt: prompt,
        expectedShape: 'object',
        correlation: { projectId },
      });
      raw = result.value;
    } catch (error) {
      // A failed draft must not look like an empty one: the client would read "we found nothing in
      // your documents" and go fill the form by hand for no reason.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Intake draft failed for project ${projectId}: ${message}`);
      throw new BadRequestException(`Could not draft from your documents right now: ${message}`);
    }

    const payload = this.coercePayload(raw, project);
    const provenance = this.coerceProvenance(raw.provenance);

    return {
      payload,
      provenance,
      sourceDocumentIds: sources.map((source) => source.id),
      usedBrief: Boolean(project.brief.trim()),
    };
  }

  /** Documents whose text was successfully extracted. Anything unreadable is silently skipped. */
  private async readableSources(projectId: string) {
    const documents = await this.prisma.collaborationDocument.findMany({
      where: { projectId, extraction: { status: DocumentExtractionStatus.READY } },
      select: {
        id: true,
        title: true,
        kind: true,
        extraction: { select: { extractedText: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    let remaining = MAX_SOURCE_CHARS;
    const sources: Array<{ id: string; title: string; kind: string; text: string }> = [];
    for (const document of documents) {
      const text = document.extraction?.extractedText?.trim();
      if (!text || remaining <= 0) continue;
      const excerpt = text.slice(0, Math.min(MAX_CHARS_PER_DOCUMENT, remaining));
      remaining -= excerpt.length;
      sources.push({ id: document.id, title: document.title, kind: document.kind, text: excerpt });
    }
    return sources;
  }

  private buildPrompt(
    project: { companyName: string; brief: string },
    sources: Array<{ id: string; title: string; kind: string; text: string }>,
  ): string {
    const documentBlock = sources.length
      ? sources
          .map((source) => `--- DOCUMENT ${source.id} · ${source.title} (${source.kind}) ---\n${source.text}`)
          .join('\n\n')
      : '(The client has not uploaded any readable documents.)';

    return `Company: ${project.companyName}

What the client told us when they first got in touch:
${project.brief.trim() || '(nothing recorded)'}

Their documents:
${documentBlock}

Return a JSON object with these keys:

"overview": { "projectName", "businessGoal", "successMeasures": [], "primaryContact", "approver", "targetLaunch" }
"roles": [ { "name", "responsibilities": [], "permissions": [] } ]
"features": [ { "title", "purpose", "primaryRole", "priority": "MUST_HAVE" | "SHOULD_HAVE" | "NICE_TO_HAVE", "workflow", "businessRules": [], "acceptanceCriteria": [] } ]
"workflows": [ { "title", "startCondition", "actor", "steps": [], "decisionPoints": [], "errorCases": [], "outcome" } ]
"dataAndIntegrations": { "entities": [ { "name", "fields": [], "accessRules": [] } ], "integrations": [ { "name", "purpose", "owner" } ] }
"experienceAndDelivery": { "designNotes", "securityRequirements": [], "constraints": [], "milestones": [], "outOfScope": [], "futurePhase": [] }
"provenance": { "<dotted field path>": { "origin": "stated" | "inferred", "documentId": "<id or omit if from the brief>" } }

Leave any value empty when the sources do not support it, and omit it from "provenance".
Provenance paths look like "overview.businessGoal", "features.0.title", "roles.1.permissions".`;
  }

  /**
   * Forces the model's answer into the payload shape.
   *
   * The model is asked for this shape and usually returns it, but "usually" is not a contract, and
   * everything downstream — the completeness rules, the form, the locked context package — indexes
   * into these fields without checking. A missing array here surfaces as a crash three screens away.
   */
  private coercePayload(
    raw: Partial<ClientIntakePayload>,
    project: { companyName: string; brief: string },
  ): ClientIntakePayload {
    const base = emptyClientIntakePayload({
      projectName: project.companyName,
      companyName: project.companyName,
      brief: project.brief,
    });
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    const list = (value: unknown) =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
    const rows = (value: unknown) => (Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : []);

    const overview = (raw.overview ?? {}) as Record<string, unknown>;
    const data = (raw.dataAndIntegrations ?? {}) as Record<string, unknown>;
    const delivery = (raw.experienceAndDelivery ?? {}) as Record<string, unknown>;

    return {
      overview: {
        // The project name falls back to the company rather than staying blank: it is the one field
        // we already know, and asking for it back reads as the system not having been paying attention.
        projectName: text(overview.projectName) || base.overview.projectName,
        businessGoal: text(overview.businessGoal),
        successMeasures: list(overview.successMeasures),
        primaryContact: text(overview.primaryContact),
        approver: text(overview.approver),
        targetLaunch: text(overview.targetLaunch),
      },
      roles: rows(raw.roles).map((role) => {
        const r = role as Record<string, unknown>;
        return { name: text(r.name), responsibilities: list(r.responsibilities), permissions: list(r.permissions) };
      }),
      features: rows(raw.features).map((feature) => {
        const f = feature as Record<string, unknown>;
        const priority = text(f.priority).toUpperCase();
        return {
          title: text(f.title),
          purpose: text(f.purpose),
          primaryRole: text(f.primaryRole),
          priority:
            priority === 'SHOULD_HAVE' || priority === 'NICE_TO_HAVE'
              ? (priority as 'SHOULD_HAVE' | 'NICE_TO_HAVE')
              : 'MUST_HAVE',
          workflow: text(f.workflow),
          businessRules: list(f.businessRules),
          acceptanceCriteria: list(f.acceptanceCriteria),
        };
      }),
      workflows: rows(raw.workflows).map((workflow) => {
        const w = workflow as Record<string, unknown>;
        return {
          title: text(w.title),
          startCondition: text(w.startCondition),
          actor: text(w.actor),
          steps: list(w.steps),
          decisionPoints: list(w.decisionPoints),
          errorCases: list(w.errorCases),
          outcome: text(w.outcome),
        };
      }),
      dataAndIntegrations: {
        entities: rows(data.entities).map((entity) => {
          const e = entity as Record<string, unknown>;
          return { name: text(e.name), fields: list(e.fields), accessRules: list(e.accessRules) };
        }),
        integrations: rows(data.integrations).map((integration) => {
          const i = integration as Record<string, unknown>;
          return { name: text(i.name), purpose: text(i.purpose), owner: text(i.owner) };
        }),
        // Never auto-tick "not applicable". It is an assertion the client makes, and a wrong one
        // silently removes a whole section from the scope the agents build to.
        dataNotApplicable: false,
        integrationsNotApplicable: false,
      },
      experienceAndDelivery: {
        designNotes: text(delivery.designNotes),
        securityRequirements: list(delivery.securityRequirements),
        constraints: list(delivery.constraints),
        milestones: list(delivery.milestones),
        outOfScope: list(delivery.outOfScope),
        futurePhase: list(delivery.futurePhase),
        documentsNotApplicable: false,
      },
    };
  }

  /** Keeps only provenance entries with a usable origin; everything else reads as unsourced. */
  private coerceProvenance(raw: unknown): IntakeDraftProvenance {
    if (!raw || typeof raw !== 'object') return {};
    const provenance: IntakeDraftProvenance = {};
    for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      const origin = typeof entry.origin === 'string' ? entry.origin.toLowerCase() : '';
      if (origin !== 'stated' && origin !== 'inferred') continue;
      provenance[path] = {
        origin: origin as IntakeFieldOrigin,
        documentId: typeof entry.documentId === 'string' && entry.documentId ? entry.documentId : undefined,
      };
    }
    return provenance;
  }
}
