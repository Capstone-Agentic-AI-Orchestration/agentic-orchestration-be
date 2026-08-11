import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CollaborationDocumentKind,
  DocumentExtractionStatus,
  NotificationType,
  Prisma,
  ProjectIntakeStatus,
  ProjectTimelineEventType,
  ProjectTimelineVisibility,
  UserRole,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { AuthUser } from '../auth/auth.types';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentExtractionService } from './document-extraction.service';
import { DocumentStorageService } from './document-storage.service';
import {
  INTAKE_TEMPLATE_INTRO,
  INTAKE_TEMPLATE_SECTIONS,
  renderIntakeTemplateHtml,
  renderIntakeTemplateMarkdown,
} from './intake-template';
import {
  ClientIntakePayload,
  emptyClientIntakePayload,
  INTAKE_SECTION_IDS,
  IntakeContextPackage,
  IntakeSectionBlocker,
} from './intake.types';

type UploadedFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

const MAX_FILE_BYTES = Number(process.env.DOCUMENT_MAX_BYTES ?? 25 * 1024 * 1024);
const MAX_PROJECT_BYTES = Number(process.env.DOCUMENT_MAX_TOTAL_BYTES ?? 100 * 1024 * 1024);
const MAX_DOCUMENTS = Number(process.env.DOCUMENT_MAX_PER_PROJECT ?? 20);
const MAX_AGENT_SOURCE_CHARS = 80_000;
const MAX_SOURCE_CHARS_PER_DOCUMENT = 12_000;

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

/**
 * Who may read or write a project's intake. Exported so IntakeDraftService shares the exact rule
 * rather than growing a second copy that can drift apart from this one.
 */
export const projectAccessWhere = (user: AuthUser, projectId: string): Prisma.ProjectWhereInput => {
  if (user.role === UserRole.ADMIN) return { id: projectId };
  return {
    id: projectId,
    OR: [{ createdById: user.id }, { members: { some: { userId: user.id } } }],
  };
};

@Injectable()
export class IntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: DocumentStorageService,
    private readonly extraction: DocumentExtractionService,
    private readonly notifications: NotificationsService,
  ) {}

  async getIntake(projectId: string, user: AuthUser) {
    const project = await this.assertAccessible(projectId, user);
    const intake = await this.ensureActiveIntake(project, user);
    const loaded = await this.prisma.projectIntake.findUnique({
      where: { id: intake.id },
      include: {
        comments: { orderBy: { createdAt: 'asc' } },
        snapshots: {
          select: { id: true, version: true, lockedAt: true, pmNotes: true },
          orderBy: { version: 'desc' },
        },
      },
    });
    const documents = await this.prisma.collaborationDocument.findMany({
      where: { projectId },
      include: {
        extraction: {
          select: {
            status: true,
            error: true,
            attempts: true,
            extractedAt: true,
            updatedAt: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return {
      intake: loaded,
      documents: user.role === UserRole.CLIENT ? documents.filter((document) => document.clientVisible) : documents,
      readiness: this.readinessFor(this.toPayload(loaded?.payload), documents),
      templateMarkdown: this.templateMarkdown(),
      // The question wording itself, so both frontends render labels from the worksheet instead
      // of hardcoding their own. Sent on every intake read rather than fetched separately: it is
      // a few KB, it never changes without a deploy, and a second round-trip is the kind of thing
      // that gets skipped, which is how the wording drifted apart in the first place.
      template: { intro: INTAKE_TEMPLATE_INTRO, sections: INTAKE_TEMPLATE_SECTIONS },
    };
  }

  async saveDraft(projectId: string, user: AuthUser, rawPayload: Record<string, unknown>) {
    this.assertIntakeEditor(user);
    const project = await this.assertAccessible(projectId, user);
    const intake = await this.ensureActiveIntake(project, user);
    const payload = this.normalizePayload(rawPayload, project.companyName, project.brief, user.email);
    const editableStatuses: ProjectIntakeStatus[] = [
      ProjectIntakeStatus.DRAFT,
      ProjectIntakeStatus.CHANGES_REQUESTED,
      ProjectIntakeStatus.LOCKED,
    ];
    if (!editableStatuses.includes(intake.status)) {
      throw new BadRequestException('The intake is under PM review. Wait for a change request before editing it.');
    }
    // The immutable snapshot captures each locked version. Reopening the active
    // working record starts a new version without changing any prior snapshot.
    const nextVersion = intake.status === ProjectIntakeStatus.LOCKED ? intake.version + 1 : intake.version;
    const updated = await this.prisma.projectIntake.update({
      where: { id: intake.id },
      data: {
        payload: payload as unknown as Prisma.InputJsonValue,
        status: ProjectIntakeStatus.DRAFT,
        version: nextVersion,
        reviewNote: null,
        reviewedAt: null,
        reviewedById: null,
      },
      include: { comments: { orderBy: { createdAt: 'asc' } } },
    });
    return { intake: updated, readiness: this.readinessFor(payload, await this.projectDocuments(projectId)) };
  }

  async submit(projectId: string, user: AuthUser) {
    this.assertIntakeEditor(user);
    const project = await this.assertAccessible(projectId, user);
    const intake = await this.ensureActiveIntake(project, user);
    const payload = this.toPayload(intake.payload);
    const readiness = this.readinessFor(payload, await this.projectDocuments(projectId));
    if (!readiness.readyForSubmission) {
      throw new BadRequestException(`Complete the client intake before submitting: ${readiness.blockers.join(' ')}`);
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.projectIntakeComment.updateMany({
        where: { intakeId: intake.id, resolvedAt: null },
        data: { resolvedAt: now },
      });
      return tx.projectIntake.update({
        where: { id: intake.id },
        data: {
          status: ProjectIntakeStatus.SUBMITTED,
          submittedById: user.id,
          submittedAt: now,
        },
        include: { comments: { orderBy: { createdAt: 'asc' } } },
      });
    });
    await this.recordTimeline(projectId, user, ProjectTimelineEventType.INTAKE_SUBMITTED, 'Client intake submitted', 'The client submitted requirements for PM review');
    await this.notifications.notify({
      recipientIds: await this.notifications.projectManagers(projectId),
      actorId: user.id,
      projectId,
      type: NotificationType.INTAKE_SUBMITTED,
      title: 'Client intake submitted',
      body: `${project.companyName} is ready for your requirements review.`,
      metadata: { intakeId: intake.id, version: intake.version },
    });
    return { intake: updated, readiness };
  }

  async requestChanges(projectId: string, user: AuthUser, input: { section: string; message: string }) {
    this.assertManager(user);
    await this.assertAccessible(projectId, user);
    const intake = await this.findIntake(projectId);
    const reviewableStatuses: ProjectIntakeStatus[] = [ProjectIntakeStatus.SUBMITTED, ProjectIntakeStatus.READY];
    if (!reviewableStatuses.includes(intake.status)) {
      throw new BadRequestException('Only a submitted or ready intake can be returned for changes');
    }
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const comment = await tx.projectIntakeComment.create({
        data: { intakeId: intake.id, section: input.section.trim(), message: input.message.trim(), createdById: user.id },
      });
      const updated = await tx.projectIntake.update({
        where: { id: intake.id },
        data: {
          status: ProjectIntakeStatus.CHANGES_REQUESTED,
          reviewedById: user.id,
          reviewedAt: now,
          reviewNote: input.message.trim(),
        },
      });
      return { intake: updated, comment };
    });
    await this.recordTimeline(projectId, user, ProjectTimelineEventType.INTAKE_CHANGES_REQUESTED, 'Intake changes requested', input.message, { section: input.section });
    await this.notifications.notify({
      recipientIds: await this.notifications.projectClients(projectId),
      actorId: user.id,
      projectId,
      type: NotificationType.INTAKE_CHANGES_REQUESTED,
      title: 'Your project intake needs an update',
      body: input.message,
      metadata: { intakeId: intake.id, section: input.section, commentId: result.comment.id },
    });
    return result;
  }

  async markReady(projectId: string, user: AuthUser, note?: string) {
    this.assertManager(user);
    await this.assertAccessible(projectId, user);
    const intake = await this.findIntake(projectId);
    if (intake.status !== ProjectIntakeStatus.SUBMITTED) {
      throw new BadRequestException('Only a submitted intake can be marked ready');
    }
    const readiness = this.readinessFor(this.toPayload(intake.payload), await this.projectDocuments(projectId));
    if (!readiness.readyForLock) {
      throw new BadRequestException(`Resolve intake blockers before marking ready: ${readiness.blockers.join(' ')}`);
    }
    const updated = await this.prisma.projectIntake.update({
      where: { id: intake.id },
      data: {
        status: ProjectIntakeStatus.READY,
        reviewedById: user.id,
        reviewedAt: new Date(),
        reviewNote: note?.trim() || null,
      },
    });
    await this.recordTimeline(projectId, user, ProjectTimelineEventType.INTAKE_READY, 'Intake ready for orchestration', note || 'PM completed the intake review');
    await this.notifications.notify({
      recipientIds: await this.notifications.projectClients(projectId),
      actorId: user.id,
      projectId,
      type: NotificationType.INTAKE_READY,
      title: 'Project requirements accepted',
      body: 'Your project manager accepted the intake and is preparing the build.',
      metadata: { intakeId: intake.id },
    });
    return { intake: updated, readiness };
  }

  async lock(projectId: string, user: AuthUser, pmNotes?: string) {
    this.assertManager(user);
    const project = await this.assertAccessible(projectId, user);
    const intake = await this.findIntake(projectId);
    if (intake.status !== ProjectIntakeStatus.READY) {
      throw new BadRequestException('Mark the submitted intake ready before locking it');
    }
    const documents = await this.projectDocuments(projectId);
    const payload = this.toPayload(intake.payload);
    const readiness = this.readinessFor(payload, documents);
    if (!readiness.readyForLock) {
      throw new BadRequestException(`Resolve intake blockers before locking: ${readiness.blockers.join(' ')}`);
    }
    const latest = await this.prisma.projectIntakeSnapshot.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;
    const snapshot = await this.prisma.projectIntakeSnapshot.create({
      data: {
        projectId,
        intakeId: intake.id,
        version,
        payload: payload as unknown as Prisma.InputJsonValue,
        contextPackage: {},
        pmNotes: pmNotes?.trim() || null,
        lockedById: user.id,
      },
    });
    const contextPackage = this.buildContextPackage({
      project,
      snapshotId: snapshot.id,
      version,
      payload,
      documents,
      pmNotes: pmNotes ?? '',
    });
    const [updatedSnapshot] = await this.prisma.$transaction([
      this.prisma.projectIntakeSnapshot.update({
        where: { id: snapshot.id },
        data: { contextPackage: contextPackage as unknown as Prisma.InputJsonValue },
      }),
      this.prisma.projectIntake.update({
        where: { id: intake.id },
        data: { status: ProjectIntakeStatus.LOCKED, reviewedById: user.id, reviewedAt: new Date() },
      }),
    ]);
    await this.recordTimeline(projectId, user, ProjectTimelineEventType.INTAKE_LOCKED, 'Intake scope locked', pmNotes || `Locked intake version ${version}`, { snapshotId: snapshot.id, version });
    await this.notifications.notify({
      recipientIds: await this.notifications.projectClients(projectId),
      actorId: user.id,
      projectId,
      type: NotificationType.INTAKE_LOCKED,
      title: 'Project intake accepted',
      body: 'Your requirements are now locked for this build. Contact the PM to request a scope change.',
      metadata: { snapshotId: snapshot.id, version },
    });
    return { snapshot: updatedSnapshot, contextPackage, readiness };
  }

  /** Returns the locked package for a run. Legacy projects receive a brief-derived snapshot once. */
  async contextForStart(project: { id: string; companyName: string; brief: string; createdById?: string | null }, actorId?: string): Promise<IntakeContextPackage> {
    const locked = await this.prisma.projectIntakeSnapshot.findFirst({
      where: { projectId: project.id },
      orderBy: { version: 'desc' },
    });
    if (locked) return locked.contextPackage as unknown as IntakeContextPackage;

    const existing = await this.prisma.projectIntake.findUnique({ where: { projectId: project.id } });
    if (existing) {
      throw new BadRequestException('A project intake exists but has not been locked. Complete PM review before starting orchestration.');
    }

    const payload = emptyClientIntakePayload({
      projectName: project.companyName,
      companyName: project.companyName,
      brief: project.brief,
    });
    const intake = await this.prisma.projectIntake.create({
      data: {
        projectId: project.id,
        payload: payload as unknown as Prisma.InputJsonValue,
        status: ProjectIntakeStatus.LOCKED,
        createdById: actorId ?? project.createdById ?? null,
        submittedById: actorId ?? project.createdById ?? null,
        submittedAt: new Date(),
        reviewedById: actorId ?? project.createdById ?? null,
        reviewedAt: new Date(),
        reviewNote: 'Brief-derived legacy intake created when orchestration started.',
      },
    });
    const snapshot = await this.prisma.projectIntakeSnapshot.create({
      data: {
        projectId: project.id,
        intakeId: intake.id,
        version: 1,
        payload: payload as unknown as Prisma.InputJsonValue,
        contextPackage: {},
        pmNotes: 'Brief-derived compatibility intake',
        lockedById: actorId ?? project.createdById ?? null,
      },
    });
    const contextPackage = this.buildContextPackage({
      project,
      snapshotId: snapshot.id,
      version: 1,
      payload,
      documents: [],
      pmNotes: 'Brief-derived compatibility intake',
    });
    await this.prisma.projectIntakeSnapshot.update({
      where: { id: snapshot.id },
      data: { contextPackage: contextPackage as unknown as Prisma.InputJsonValue },
    });
    return contextPackage;
  }

  async uploadDocument(
    projectId: string,
    user: AuthUser,
    file: UploadedFile,
    input: { title?: string; description?: string; kind?: string; clientVisible?: string },
  ) {
    this.assertIntakeEditor(user);
    await this.assertAccessible(projectId, user);
    this.validateUpload(file);
    const [count, totalSize] = await Promise.all([
      this.prisma.collaborationDocument.count({ where: { projectId, storageKey: { not: null } } }),
      this.prisma.collaborationDocument.aggregate({ where: { projectId, storageKey: { not: null } }, _sum: { sizeBytes: true } }),
    ]);
    if (count >= MAX_DOCUMENTS) throw new BadRequestException(`A project intake can contain at most ${MAX_DOCUMENTS} uploaded documents`);
    if ((totalSize._sum.sizeBytes ?? 0) + file.size > MAX_PROJECT_BYTES) {
      throw new BadRequestException('This upload exceeds the project document storage limit');
    }

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const existing = await this.prisma.collaborationDocument.findFirst({ where: { projectId, sha256 }, include: { extraction: true } });
    if (existing) return { document: existing, duplicate: true };

    const extension = this.extensionFor(file.originalname);
    const mimeType = MIME_BY_EXTENSION[extension];
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
    const storageKey = `${projectId}/${sha256}-${safeName}`;
    await this.storage.upload(storageKey, file.buffer, mimeType);

    const kind = this.documentKind(input.kind);
    const document = await this.prisma.collaborationDocument.create({
      data: {
        projectId,
        title: input.title?.trim() || file.originalname,
        description: input.description?.trim() || null,
        fileName: file.originalname,
        storageKey,
        mimeType,
        sizeBytes: file.size,
        sha256,
        kind,
        clientVisible: input.clientVisible === 'true' || user.role === UserRole.CLIENT,
        uploadedById: user.id,
        extraction: { create: { status: DocumentExtractionStatus.PENDING } },
      },
      include: { extraction: true },
    });
    await this.recordTimeline(projectId, user, ProjectTimelineEventType.COLLAB_DOCUMENT_UPLOADED, 'Intake document uploaded', document.title, { documentId: document.id, sha256 });
    void this.processDocument(document.id);
    return { document, duplicate: false };
  }

  async retryExtraction(projectId: string, documentId: string, user: AuthUser) {
    this.assertManager(user);
    await this.assertAccessible(projectId, user);
    const document = await this.prisma.collaborationDocument.findFirst({
      where: { id: documentId, projectId },
      include: { extraction: true },
    });
    if (!document?.storageKey) throw new NotFoundException('Uploaded document not found');
    void this.processDocument(document.id);
    return { documentId: document.id, status: DocumentExtractionStatus.PENDING };
  }

  async downloadDocument(projectId: string, documentId: string, user: AuthUser) {
    await this.assertAccessible(projectId, user);
    const document = await this.prisma.collaborationDocument.findFirst({
      where: { id: documentId, projectId, ...(user.role === UserRole.CLIENT ? { clientVisible: true } : {}) },
    });
    if (!document?.storageKey || !document.fileName || !document.mimeType) throw new NotFoundException('Uploaded document not found');
    return { fileName: document.fileName, contentType: document.mimeType, content: await this.storage.download(document.storageKey) };
  }

  /** Rendered from the shared worksheet definition so it cannot drift from the intake form. */
  templateMarkdown(): string {
    return renderIntakeTemplateMarkdown();
  }

  /** Printable worksheet: opens in Word or Google Docs, and prints to PDF from any browser. */
  templateHtml(): string {
    return renderIntakeTemplateHtml();
  }

  /**
   * Awaited re-run of extraction for a single document, used by the recovery sweep.
   *
   * The upload path deliberately fires extraction without awaiting it so the request returns
   * promptly; recovery is the opposite case and must know when the work finished.
   */
  reprocessDocument(documentId: string): Promise<void> {
    return this.processDocument(documentId);
  }

  private async processDocument(documentId: string): Promise<void> {
    const document = await this.prisma.collaborationDocument.findUnique({
      where: { id: documentId },
      include: { extraction: true },
    });
    if (!document?.storageKey || !document.fileName || !document.mimeType) return;
    await this.prisma.documentExtraction.upsert({
      where: { documentId },
      create: { documentId, status: DocumentExtractionStatus.EXTRACTING, attempts: 1 },
      update: { status: DocumentExtractionStatus.EXTRACTING, error: null, attempts: { increment: 1 } },
    });
    try {
      const buffer = await this.storage.download(document.storageKey);
      const content = await this.extraction.extract({ fileName: document.fileName, mimeType: document.mimeType, buffer });
      if (!content.text.trim()) throw new Error('No readable text was found. Upload a text-based file or provide a summary.');
      await this.prisma.documentExtraction.update({
        where: { documentId },
        data: {
          status: DocumentExtractionStatus.READY,
          extractedText: this.redactSensitiveText(content.text),
          sourceLocations: content.sourceLocations as unknown as Prisma.InputJsonValue,
          error: null,
          extractedAt: new Date(),
        },
      });
    } catch (error) {
      await this.prisma.documentExtraction.update({
        where: { documentId },
        data: { status: DocumentExtractionStatus.FAILED, error: error instanceof Error ? error.message : String(error) },
      }).catch(() => undefined);
    }
  }

  private async ensureActiveIntake(project: { id: string; companyName: string; brief: string }, user: AuthUser) {
    return this.prisma.projectIntake.upsert({
      where: { projectId: project.id },
      update: {},
      create: {
        projectId: project.id,
        payload: emptyClientIntakePayload({ projectName: project.companyName, companyName: project.companyName, brief: project.brief, primaryContact: user.email }) as unknown as Prisma.InputJsonValue,
        createdById: user.id,
      },
    });
  }

  private async findIntake(projectId: string) {
    const intake = await this.prisma.projectIntake.findUnique({ where: { projectId } });
    if (!intake) throw new NotFoundException('Project intake not found');
    return intake;
  }

  private async assertAccessible(projectId: string, user: AuthUser) {
    const project = await this.prisma.project.findFirst({
      where: projectAccessWhere(user, projectId),
      select: { id: true, companyName: true, brief: true, createdById: true },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    return project;
  }

  private async projectDocuments(projectId: string) {
    return this.prisma.collaborationDocument.findMany({
      where: { projectId },
      include: { extraction: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  private readinessFor(payload: ClientIntakePayload, documents: Array<{ storageKey: string | null; extraction: { status: DocumentExtractionStatus } | null }>) {
    const tagged = this.payloadBlockers(payload);
    const uploaded = documents.filter((document) => Boolean(document.storageKey));
    const extracting = uploaded.filter((document) => document.extraction?.status === DocumentExtractionStatus.PENDING || document.extraction?.status === DocumentExtractionStatus.EXTRACTING);
    const failed = uploaded.filter((document) => document.extraction?.status === DocumentExtractionStatus.FAILED || !document.extraction);
    // All advisory. A document that is still being read, or a client who genuinely has none, is not
    // a reason to refuse a brief that already says what to build.
    if (extracting.length) tagged.push({ section: 'documents', severity: 'advisory', message: `${extracting.length} uploaded document${extracting.length === 1 ? ' is' : 's are'} still being processed.` });
    if (failed.length) tagged.push({ section: 'documents', severity: 'advisory', message: `${failed.length} uploaded document${failed.length === 1 ? ' needs' : 's need'} a successful extraction or replacement.` });
    if (!uploaded.length && !payload.experienceAndDelivery.documentsNotApplicable) {
      tagged.push({ section: 'documents', severity: 'advisory', message: 'Attach a supporting document, or tick that you have none.' });
    }

    // `sections` carries one entry per worksheet step, INCLUDING the complete ones with an empty
    // list, so a client form can render its progress rail straight from this without inventing
    // the section order or re-deriving which steps are done.
    const isBlocking = (blocker: IntakeSectionBlocker) => (blocker.severity ?? 'blocking') === 'blocking';
    const blocking = tagged.filter(isBlocking);
    const advisory = tagged.filter((blocker) => !isBlocking(blocker));

    // A section is "complete" when nothing is BLOCKING it. Advisory gaps are reported separately so
    // a form can still show what is worth adding without painting the step as unfinished.
    const sections = INTAKE_SECTION_IDS.map((section) => {
      const forSection = tagged.filter((blocker) => blocker.section === section);
      return {
        section,
        complete: !forSection.some(isBlocking),
        missing: forSection.map((blocker) => blocker.message),
        blocking: forSection.filter(isBlocking).map((blocker) => blocker.message),
        advisory: forSection.filter((blocker) => !isBlocking(blocker)).map((blocker) => blocker.message),
      };
    });

    return {
      // `blockers` keeps its old meaning — what actually stops submission — so submit/lock error
      // messages stay truthful. It is a shorter list than it was, which is the point.
      blockers: blocking.map((blocker) => blocker.message),
      /** Worth adding, never a wall. New field; older clients ignore it. */
      suggestions: advisory.map((blocker) => blocker.message),
      sections,
      readyForSubmission: blocking.length === 0,
      // Locking stays the project manager's judgement: they can lock over advisory gaps, which is
      // what makes them advisory rather than a slower kind of blocking.
      readyForLock: blocking.length === 0,
      counts: { uploaded: uploaded.length, extracting: extracting.length, failed: failed.length, ready: uploaded.length - extracting.length - failed.length },
    };
  }

  /**
   * What is still missing, attributed to the worksheet section that would fix it.
   *
   * The section tag is what lets a step-by-step client form mark each step complete or
   * incomplete, and lets the PM see at a glance which part of the brief is thin — from ONE
   * computation. Both frontends previously had to guess the mapping from the wording of a flat
   * string list, which meant the same rule was expressed three times and could disagree.
   *
   * Wording is client-facing: these strings are shown to the person who has to act on them, so
   * they name the thing to add rather than the field that failed validation.
   */
  private payloadBlockers(payload: ClientIntakePayload): IntakeSectionBlocker[] {
    const blockers: IntakeSectionBlocker[] = [];
    const block = (section: IntakeSectionBlocker['section'], message: string) =>
      blockers.push({ section, message, severity: 'blocking' });
    const advise = (section: IntakeSectionBlocker['section'], message: string) =>
      blockers.push({ section, message, severity: 'advisory' });

    // Blocking: without these there is no scope. The requirements agent is told the locked intake
    // is authoritative and not to invent beyond it, so an empty goal or no must-have feature means
    // it has nothing to build and nothing it is allowed to make up.
    const overview = payload.overview;
    if (!overview.projectName.trim()) block('overview', 'Add a project name.');
    if (!overview.businessGoal.trim()) block('overview', 'Describe the business goal.');

    const mustHave = payload.features.filter((feature) => feature.priority === 'MUST_HAVE');
    if (!mustHave.length) block('features', 'Add at least one Must-have feature.');
    if (mustHave.some((feature) => !feature.title.trim() || !feature.purpose.trim())) {
      block('features', 'Every Must-have feature needs a title and a purpose.');
    }

    // Advisory from here down. Each of these makes the build better and none of them stops it. They
    // are the project manager's call at lock, which is a human checkpoint that already exists —
    // rather than a gate the client has to satisfy before anyone has even read their brief.
    if (!overview.successMeasures.some((measure) => measure.trim())) advise('overview', 'Add at least one measurable success criterion.');
    if (!overview.primaryContact.trim()) advise('overview', 'Add a primary contact.');
    if (!overview.approver.trim()) advise('overview', 'Name the final approver.');
    if (!overview.targetLaunch.trim()) advise('overview', 'Provide a target launch period.');

    if (!payload.roles.some((role) => role.name.trim())) {
      advise('roles', 'Name at least one type of user.');
    } else if (!payload.roles.some((role) => role.name.trim() && role.responsibilities.length && role.permissions.length)) {
      // Permissions in particular: a client knows who uses the software, not what a permission
      // model should look like. Worth having, never worth blocking on.
      advise('roles', 'Add what each user does and what they are allowed to do.');
    }

    if (mustHave.some((feature) => !feature.acceptanceCriteria.some((item) => item.trim()))) {
      advise('features', 'Add how you will know each Must-have works.');
    }
    if (mustHave.some((feature) => !feature.businessRules.some((item) => item.trim()))) {
      advise('features', 'Add any rules that must always hold for your Must-haves.');
    }

    if (!payload.workflows.some((workflow) => workflow.title.trim())) {
      advise('workflows', 'Describe at least one process the software must support.');
    } else if (!payload.workflows.some((workflow) => workflow.steps.some((step) => step.trim()) && workflow.outcome.trim())) {
      advise('workflows', 'Add the steps and the end result for at least one process.');
    }

    if (!payload.dataAndIntegrations.entities.length && !payload.dataAndIntegrations.dataNotApplicable) {
      advise('data', 'List the information you keep track of, or tick that none applies.');
    }
    if (!payload.dataAndIntegrations.integrations.length && !payload.dataAndIntegrations.integrationsNotApplicable) {
      advise('data', 'List other systems this must work with, or tick that none applies.');
    }

    return blockers;
  }

  private buildContextPackage(input: {
    project: { id: string; companyName: string; brief: string };
    snapshotId: string;
    version: number;
    payload: ClientIntakePayload;
    documents: Awaited<ReturnType<IntakeService['projectDocuments']>>;
    pmNotes: string;
  }): IntakeContextPackage {
    let remaining = MAX_AGENT_SOURCE_CHARS;
    const sources = input.documents.flatMap((document) => {
      const text = document.extraction?.status === DocumentExtractionStatus.READY ? document.extraction.extractedText?.trim() : '';
      if (!text || !remaining) return [];
      const excerpt = this.redactSensitiveText(text.slice(0, Math.min(MAX_SOURCE_CHARS_PER_DOCUMENT, remaining)));
      remaining -= excerpt.length;
      return [{
        documentId: document.id,
        documentVersion: document.version,
        title: document.title,
        kind: document.kind,
        sha256: document.sha256 || '',
        locator: 'extracted document text',
        extractedText: excerpt,
      }];
    });
    const features = input.payload.features
      .filter((feature) => feature.priority !== 'NICE_TO_HAVE')
      .map((feature) => `${feature.priority}: ${feature.title} — ${feature.purpose}`)
      .join('\n');
    const canonicalBrief = [
      input.payload.overview.businessGoal || input.project.brief,
      `Project: ${input.payload.overview.projectName || input.project.companyName}.`,
      features ? `In scope:\n${features}` : '',
      input.payload.experienceAndDelivery.outOfScope.length ? `Out of scope: ${input.payload.experienceAndDelivery.outOfScope.join('; ')}` : '',
      input.payload.experienceAndDelivery.futurePhase.length ? `Future phase: ${input.payload.experienceAndDelivery.futurePhase.join('; ')}` : '',
    ].filter(Boolean).join('\n\n');
    return {
      schemaVersion: 'intake-context-v1',
      projectId: input.project.id,
      intakeSnapshotId: input.snapshotId,
      intakeVersion: input.version,
      canonicalBrief,
      clientRequirements: input.payload,
      pmNotes: input.pmNotes,
      sources,
    };
  }

  private toPayload(value: unknown): ClientIntakePayload {
    return this.normalizePayload(value && typeof value === 'object' ? value as Record<string, unknown> : {}, '', '', '');
  }

  private normalizePayload(value: Record<string, unknown>, companyName: string, brief: string, email: string | null): ClientIntakePayload {
    const fallback = emptyClientIntakePayload({ projectName: companyName, companyName, brief, primaryContact: email });
    const source = value as Partial<ClientIntakePayload>;
    return {
      overview: { ...fallback.overview, ...(source.overview ?? {}) },
      roles: Array.isArray(source.roles) ? source.roles.map((role) => ({ name: String(role?.name ?? ''), responsibilities: this.stringArray(role?.responsibilities), permissions: this.stringArray(role?.permissions) })) : [],
      features: Array.isArray(source.features) ? source.features.map((feature) => ({
        title: String(feature?.title ?? ''), purpose: String(feature?.purpose ?? ''), primaryRole: String(feature?.primaryRole ?? ''),
        priority: ['MUST_HAVE', 'SHOULD_HAVE', 'NICE_TO_HAVE'].includes(String(feature?.priority)) ? feature.priority : 'SHOULD_HAVE',
        workflow: String(feature?.workflow ?? ''), businessRules: this.stringArray(feature?.businessRules), acceptanceCriteria: this.stringArray(feature?.acceptanceCriteria),
      })) : [],
      workflows: Array.isArray(source.workflows) ? source.workflows.map((workflow) => ({
        title: String(workflow?.title ?? ''), startCondition: String(workflow?.startCondition ?? ''), actor: String(workflow?.actor ?? ''),
        steps: this.stringArray(workflow?.steps), decisionPoints: this.stringArray(workflow?.decisionPoints), errorCases: this.stringArray(workflow?.errorCases), outcome: String(workflow?.outcome ?? ''),
      })) : [],
      dataAndIntegrations: {
        entities: Array.isArray(source.dataAndIntegrations?.entities) ? source.dataAndIntegrations.entities.map((entity) => ({ name: String(entity?.name ?? ''), fields: this.stringArray(entity?.fields), accessRules: this.stringArray(entity?.accessRules) })) : [],
        integrations: Array.isArray(source.dataAndIntegrations?.integrations) ? source.dataAndIntegrations.integrations.map((integration) => ({ name: String(integration?.name ?? ''), purpose: String(integration?.purpose ?? ''), owner: String(integration?.owner ?? '') })) : [],
        dataNotApplicable: Boolean(source.dataAndIntegrations?.dataNotApplicable),
        integrationsNotApplicable: Boolean(source.dataAndIntegrations?.integrationsNotApplicable),
      },
      experienceAndDelivery: {
        designNotes: String(source.experienceAndDelivery?.designNotes ?? ''),
        securityRequirements: this.stringArray(source.experienceAndDelivery?.securityRequirements),
        constraints: this.stringArray(source.experienceAndDelivery?.constraints),
        milestones: this.stringArray(source.experienceAndDelivery?.milestones),
        outOfScope: this.stringArray(source.experienceAndDelivery?.outOfScope),
        futurePhase: this.stringArray(source.experienceAndDelivery?.futurePhase),
        documentsNotApplicable: Boolean(source.experienceAndDelivery?.documentsNotApplicable),
      },
    };
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.map((item) => String(item ?? '').trim()).filter(Boolean) : [];
  }

  private documentKind(value?: string): CollaborationDocumentKind {
    return Object.values(CollaborationDocumentKind).includes(value as CollaborationDocumentKind)
      ? value as CollaborationDocumentKind
      : CollaborationDocumentKind.REQUIREMENT;
  }

  private validateUpload(file: UploadedFile): void {
    if (!file?.buffer?.length) throw new BadRequestException('Choose a document to upload');
    if (file.size > MAX_FILE_BYTES) throw new BadRequestException(`Files must be ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB or smaller`);
    const extension = this.extensionFor(file.originalname);
    if (!MIME_BY_EXTENSION[extension]) throw new BadRequestException('Supported files are PDF, DOCX, XLSX, TXT, PNG, JPG, and JPEG');
    if (file.originalname.toLowerCase().endsWith('.xlsm')) throw new BadRequestException('Macro-enabled documents are not allowed');
    if (!this.hasExpectedSignature(extension, file.buffer)) throw new BadRequestException('The uploaded file does not match its declared file type');
    const visible = file.buffer.subarray(0, Math.min(file.buffer.length, 1_000_000)).toString('utf8');
    if (/(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|Authorization:\s*Bearer\s+\S+)/i.test(visible)) {
      throw new BadRequestException('Remove passwords, API keys, private keys, and bearer tokens before uploading documents');
    }
  }

  private extensionFor(fileName: string): string {
    return fileName.split('.').pop()?.toLowerCase() ?? '';
  }

  private hasExpectedSignature(extension: string, buffer: Buffer): boolean {
    if (extension === 'txt') return !buffer.subarray(0, 1024).includes(0);
    if (extension === 'pdf') return buffer.subarray(0, 4).toString('ascii') === '%PDF';
    if (extension === 'png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (extension === 'jpg' || extension === 'jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    return buffer.subarray(0, 2).toString('ascii') === 'PK';
  }

  private redactSensitiveText(text: string): string {
    return text
      .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_API_KEY]')
      .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_ACCESS_KEY]')
      .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
      .replace(/Authorization:\s*Bearer\s+\S+/gi, 'Authorization: Bearer [REDACTED]');
  }

  private assertIntakeEditor(user: AuthUser): void {
    const intakeEditorRoles: UserRole[] = [UserRole.CLIENT, UserRole.PM, UserRole.ADMIN];
    if (!intakeEditorRoles.includes(user.role)) {
      throw new ForbiddenException('Only client, PM, or admin users can update project intake');
    }
  }

  private assertManager(user: AuthUser): void {
    const managerRoles: UserRole[] = [UserRole.PM, UserRole.ADMIN];
    if (!managerRoles.includes(user.role)) throw new ForbiddenException('Only PM or admin users can review project intake');
  }

  private async recordTimeline(
    projectId: string,
    user: AuthUser,
    type: ProjectTimelineEventType,
    title: string,
    body?: string | null,
    metadata: Prisma.InputJsonValue = {},
  ): Promise<void> {
    await this.prisma.projectTimelineEvent.create({
      data: { projectId, actorId: user.id, type, visibility: ProjectTimelineVisibility.TEAM, title, body: body ?? null, metadata },
    });
  }
}
