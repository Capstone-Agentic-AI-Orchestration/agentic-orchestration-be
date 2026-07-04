import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ArtifactReviewStatus,
  CollaborationDocumentKind,
  CollaborationDocumentStatus,
  CollaborationVisibility,
  ConversationCategory,
  GateDecision,
  GateType,
  ClientInviteStatus,
  InquiryStatus,
  NotificationType,
  PrismaClient,
  ProjectDeliveryReviewStatus,
  ProjectKickoffStatus,
  ProjectStatus,
  ProjectTaskActivityType,
  ProjectTaskStatus,
  ProjectTimelineEventType,
  ProjectTimelineVisibility,
  UserRole,
  WorkOrderAgentType,
  WorkOrderPriority,
  WorkOrderStatus,
} from '@prisma/client';

function loadEnvFile() {
  const envPath = resolve(process.cwd(), '.env');
  let content = '';

  try {
    content = readFileSync(envPath, 'utf8');
  } catch {
    return;
  }

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key]) continue;

    process.env[key] = rawValue.replace(/^["']|["']$/g, '');
  }
}

loadEnvFile();

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Check devflow-be/.env.');
  process.exit(1);
}

const prisma = new PrismaClient();

const projectId = process.env.DEMO_PROJECT_ID ?? 'demo-persona-project';
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const demoPassword = process.env.DEMO_AUTH_PASSWORD ?? 'DevFlowDemo123!';
const personas = {
  pm: {
    email: (process.env.DEMO_PM_EMAIL ?? 'devflow.pm@example.com').toLowerCase(),
    explicitEmail: Boolean(process.env.DEMO_PM_EMAIL),
    fullName: process.env.DEMO_PM_NAME ?? 'DevFlow Demo PM',
    role: UserRole.PM,
  },
  dev: {
    email: (process.env.DEMO_DEV_EMAIL ?? 'devflow.dev@example.com').toLowerCase(),
    explicitEmail: Boolean(process.env.DEMO_DEV_EMAIL),
    fullName: process.env.DEMO_DEV_NAME ?? 'DevFlow Demo Developer',
    role: UserRole.DEV,
  },
  client: {
    email: (process.env.DEMO_CLIENT_EMAIL ?? 'devflow.client@example.com').toLowerCase(),
    explicitEmail: Boolean(process.env.DEMO_CLIENT_EMAIL),
    fullName: process.env.DEMO_CLIENT_NAME ?? 'DevFlow Demo Client',
    role: UserRole.CLIENT,
  },
};

async function resolveAuthUser(persona) {
  const existingUser = await findAuthUserByEmail(persona.email);
  if (existingUser) {
    return existingUser;
  }

  if (supabaseUrl && supabaseServiceRoleKey) {
    const createdUser = await createAuthUser(persona);
    if (createdUser) {
      return createdUser;
    }
  }

  if (supabaseUrl && supabaseAnonKey) {
    const signedUpUser = await signUpAuthUser(persona);
    if (signedUpUser) {
      return signedUpUser;
    }
  }

  if (persona.explicitEmail) {
    throw new Error(
      `Missing Supabase Auth user for ${persona.email}. Sign up or create this user first, then rerun npm run seed:demo.`,
    );
  }

  return null;
}

async function findAuthUserByEmail(email) {
  const rows = await prisma.$queryRawUnsafe(
    'select id::text as id, email from auth.users where lower(email) = lower($1) limit 1',
    email,
  );

  const user = rows[0];
  if (!user?.id) {
    return null;
  }

  return {
    id: user.id,
    email: user.email ?? email,
  };
}

async function createAuthUser(persona) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: persona.email,
      password: demoPassword,
      email_confirm: true,
      user_metadata: {
        full_name: persona.fullName,
        devflow_demo_role: persona.role,
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Failed to create Supabase Auth user ${persona.email}: ${payload.msg || payload.message || response.statusText}`,
    );
  }

  return {
    id: payload.id,
    email: payload.email ?? persona.email,
  };
}

async function signUpAuthUser(persona) {
  const response = await fetch(`${supabaseUrl}/auth/v1/signup`, {
    method: 'POST',
    headers: {
      apikey: supabaseAnonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: persona.email,
      password: demoPassword,
      data: {
        full_name: persona.fullName,
        devflow_demo_role: persona.role,
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Failed to sign up demo auth user ${persona.email}: ${payload.msg || payload.message || response.statusText}`,
    );
  }

  const user = payload.user ?? payload;
  if (!user?.id) {
    throw new Error(`Supabase signup for ${persona.email} did not return a user id.`);
  }

  return {
    id: user.id,
    email: user.email ?? persona.email,
  };
}

async function upsertProfile(key, persona) {
  const authUser = await resolveAuthUser(persona);
  if (!authUser) {
    const existingProfile = await prisma.profile.findFirst({
      where: { role: persona.role },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
      },
    });

    if (!existingProfile) {
      throw new Error(
        `Missing ${key} profile. Sign in as a ${persona.role} user, or set DEMO_${key}_EMAIL to a Supabase Auth user email.`,
      );
    }

    console.log(`Profile ${key}: reusing ${existingProfile.email ?? existingProfile.id} (${existingProfile.role})`);
    return existingProfile;
  }

  const profile = await prisma.profile.upsert({
    where: { id: authUser.id },
    update: {
      email: authUser.email,
      fullName: persona.fullName,
      role: persona.role,
    },
    create: {
      id: authUser.id,
      email: authUser.email,
      fullName: persona.fullName,
      role: persona.role,
    },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
    },
  });

  console.log(`Profile ${key}: ${profile.email ?? profile.id} (${profile.role})`);
  return profile;
}

async function resetProject() {
  await prisma.clientInquiry.deleteMany({
    where: { id: { in: ['demo-inquiry-new', 'demo-inquiry-approved', 'demo-inquiry-rejected'] } },
  });
  await prisma.notification.deleteMany({ where: { projectId } });
  await prisma.conversationRead.deleteMany({
    where: { conversation: { projectId } },
  });
  await prisma.projectMessage.deleteMany({ where: { projectId } });
  await prisma.projectConversation.deleteMany({ where: { projectId } });
  await prisma.collaborationDocument.deleteMany({ where: { projectId } });
  await prisma.workOrder.deleteMany({ where: { projectId } });
  await prisma.projectTaskActivity.deleteMany({ where: { projectId } });
  await prisma.projectTask.deleteMany({ where: { projectId } });
  await prisma.projectTimelineEvent.deleteMany({ where: { projectId } });
  await prisma.projectDeliveryReview.deleteMany({ where: { projectId } });
  await prisma.eventLog.deleteMany({ where: { projectId } });
  await prisma.gateEvent.deleteMany({ where: { projectId } });
  await prisma.runBudget.deleteMany({ where: { projectId } });
  await prisma.artifact.deleteMany({ where: { projectId } });
  await prisma.projectMember.deleteMany({ where: { projectId } });
  await prisma.project.deleteMany({ where: { id: projectId } });
}

async function seed() {
  const pm = await upsertProfile('PM', personas.pm);
  const dev = await upsertProfile('DEV', personas.dev);
  const client = await upsertProfile('CLIENT', personas.client);

  await resetProject();

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

  await prisma.project.create({
    data: {
      id: projectId,
      companyName: 'DevFlow Demo Co',
      brief:
        'A seeded demo project for testing PM, Developer, and Client views with artifacts, tasks, notifications, timeline events, and work orders.',
      stackKey: 'nextjs-nestjs-supabase',
      status: ProjectStatus.AWAITING_GATE_2,
      runId: 'demo-run-personas',
      repoUrl: 'https://github.com/example/devflow-demo',
      createdById: pm.id,
      members: {
        create: [
          { userId: dev.id, role: UserRole.DEV },
          { userId: client.id, role: UserRole.CLIENT },
        ],
      },
      runBudget: {
        create: {
          tokenBudget: 200000,
          tokensConsumed: 48500,
          retryCount: 1,
          maxRetries: 2,
        },
      },
    },
  });

  await prisma.clientInquiry.createMany({
    data: [
      {
        id: 'demo-inquiry-new',
        companyName: 'Marikina Logistics Group',
        contactName: 'Mara Santos',
        email: 'mara.santos@example.com',
        phone: '+63 915 222 0101',
        role: 'Operations Lead',
        brief:
          'We need a customer portal for shipment tracking, account billing, and support requests across regional branches.',
        stackKey: 'nextjs-nestjs-supabase',
        budgetRange: 'PHP 500k-800k',
        timeline: 'Kickoff within the next month',
        status: InquiryStatus.NEW,
        createdAt: now,
      },
      {
        id: 'demo-inquiry-approved',
        companyName: 'DevFlow Demo Co',
        contactName: client.fullName ?? 'DevFlow Demo Client',
        email: client.email ?? personas.client.email,
        phone: '+63 915 810 1010',
        role: 'Product Owner',
        brief:
          'A seeded demo project for testing PM, Developer, and Client views with artifacts, tasks, notifications, timeline events, and work orders.',
        stackKey: 'nextjs-nestjs-supabase',
        budgetRange: 'Demo',
        timeline: 'Seeded workflow',
        status: InquiryStatus.APPROVED,
        reviewNote: 'Approved during demo seeding.',
        reviewedById: pm.id,
        reviewedAt: twoHoursAgo,
        approvedProjectId: projectId,
        createdAt: twoHoursAgo,
      },
      {
        id: 'demo-inquiry-rejected',
        companyName: 'Static Brochure LLC',
        contactName: 'Rina Cruz',
        email: 'rina.cruz@example.com',
        brief:
          'We only need a one-page static brochure site and do not require the DevFlow delivery workflow right now.',
        stackKey: 'nextjs-nestjs-supabase',
        status: InquiryStatus.REJECTED,
        reviewNote: 'Not a fit for the current delivery model.',
        reviewedById: pm.id,
        reviewedAt: oneHourAgo,
        createdAt: twoHoursAgo,
      },
    ],
  });

  await prisma.clientInvite.create({
    data: {
      id: 'demo-client-invite-accepted',
      inquiryId: 'demo-inquiry-approved',
      projectId,
      email: client.email ?? personas.client.email,
      contactName: client.fullName ?? 'DevFlow Demo Client',
      companyName: 'DevFlow Demo Co',
      status: ClientInviteStatus.ACCEPTED,
      createdById: pm.id,
      acceptedById: client.id,
      acceptedAt: twoHoursAgo,
      createdAt: twoHoursAgo,
    },
  });

  await prisma.projectKickoff.create({
    data: {
      projectId,
      scopeSummary:
        'Seeded kickoff confirms the demo dashboard scope, shared client review path, and persona handoff workflow.',
      milestones: '1. Kickoff and access confirmation\n2. Architecture handoff\n3. Implementation pass\n4. Client review',
      requiredDocuments: 'Requirements brief, architecture plan, dashboard preview, and client review notes.',
      techStackNotes: 'Next.js frontend, NestJS backend, Supabase Postgres/Auth, and Prisma for persistence.',
      deliveryRoles: `${pm.fullName ?? pm.email} owns delivery, ${dev.fullName ?? dev.email} owns implementation, ${client.fullName ?? client.email} owns review.`,
      readinessNotes: 'Demo project is pre-cleared for orchestration smoke coverage.',
      scopeConfirmed: true,
      milestonesConfirmed: true,
      documentsConfirmed: true,
      techStackConfirmed: true,
      rolesConfirmed: true,
      clientAccessConfirmed: true,
      initialTasksCreated: true,
      initialWorkOrdersCreated: true,
      status: ProjectKickoffStatus.READY,
      completedById: pm.id,
      completedAt: twoHoursAgo,
      updatedById: pm.id,
      createdAt: twoHoursAgo,
    },
  });

  await prisma.projectDeliveryReview.create({
    data: {
      projectId,
      status: ProjectDeliveryReviewStatus.REVISION_REQUESTED,
      revisionNote: 'Please tighten the final handoff checklist before we accept delivery.',
      revisionRequestedById: client.id,
      revisionRequestedAt: now,
      createdAt: now,
    },
  });

  await prisma.gateEvent.createMany({
    data: [
      {
        id: 'demo-gate-architecture',
        projectId,
        gateType: GateType.ARCHITECTURE_REVIEW,
        decision: GateDecision.APPROVED,
        notes: 'Approved demo architecture handoff.',
        decidedAt: twoHoursAgo,
      },
    ],
  });

  await prisma.artifact.createMany({
    data: [
      {
        id: 'demo-artifact-architecture',
        projectId,
        agentType: 'architecture',
        filePath: 'docs/architecture.md',
        content: '# Architecture\n\nDemo architecture plan for the seeded persona project.',
        clientVisible: true,
        displayName: 'Architecture Plan',
        sharedAt: twoHoursAgo,
        reviewStatus: ArtifactReviewStatus.APPROVED,
        reviewNote: 'Architecture looks aligned with the project brief.',
        reviewedAt: oneHourAgo,
        reviewedById: client.id,
        createdAt: twoHoursAgo,
      },
      {
        id: 'demo-artifact-frontend',
        projectId,
        agentType: 'frontend',
        filePath: 'src/app/dashboard/page.tsx',
        content: 'export default function DashboardPage() { return <main>Demo dashboard</main>; }',
        clientVisible: true,
        displayName: 'Dashboard Preview',
        sharedAt: oneHourAgo,
        reviewStatus: ArtifactReviewStatus.REVISION_REQUESTED,
        reviewNote: 'Please make the task list easier to scan before the next client review.',
        reviewedAt: now,
        reviewedById: client.id,
        createdAt: oneHourAgo,
      },
      {
        id: 'demo-artifact-backend',
        projectId,
        agentType: 'backend',
        filePath: 'src/projects/projects.service.ts',
        content: 'export class DemoProjectsService {}',
        clientVisible: false,
        displayName: 'Backend Service Draft',
        reviewStatus: ArtifactReviewStatus.PENDING,
        createdAt: oneHourAgo,
      },
    ],
  });

  await prisma.projectTask.createMany({
    data: [
      {
        id: 'demo-task-frontend-revision',
        projectId,
        artifactId: 'demo-artifact-frontend',
        title: 'Revise dashboard task list',
        description: 'Apply client revision notes and keep the dashboard task list compact and scannable.',
        status: ProjectTaskStatus.IN_PROGRESS,
        assignedToId: dev.id,
        createdById: pm.id,
        createdAt: oneHourAgo,
      },
      {
        id: 'demo-task-backend-api',
        projectId,
        artifactId: 'demo-artifact-backend',
        title: 'Review backend project endpoints',
        description: 'Check project, artifact, task, timeline, and work-order endpoint behavior.',
        status: ProjectTaskStatus.TODO,
        assignedToId: dev.id,
        createdById: pm.id,
        createdAt: oneHourAgo,
      },
      {
        id: 'demo-task-client-packaging',
        projectId,
        artifactId: 'demo-artifact-architecture',
        title: 'Prepare client handoff notes',
        description: 'Summarize what the client can review and which items remain internal.',
        status: ProjectTaskStatus.IN_REVIEW,
        assignedToId: null,
        createdById: pm.id,
        createdAt: now,
      },
    ],
  });

  await prisma.projectTaskActivity.createMany({
    data: [
      {
        id: 'demo-activity-task-created',
        projectId,
        taskId: 'demo-task-frontend-revision',
        actorId: pm.id,
        type: ProjectTaskActivityType.TASK_CREATED,
        message: 'Task created from client revision request.',
        metadata: { source: 'demo-seed' },
        createdAt: oneHourAgo,
      },
      {
        id: 'demo-activity-dev-comment',
        projectId,
        taskId: 'demo-task-frontend-revision',
        actorId: dev.id,
        type: ProjectTaskActivityType.COMMENT,
        message: 'I am updating spacing and list density before moving this to review.',
        metadata: { source: 'demo-seed' },
        createdAt: now,
      },
    ],
  });

  await prisma.workOrder.createMany({
    data: [
      {
        id: 'demo-work-order-frontend',
        projectId,
        taskId: 'demo-task-frontend-revision',
        artifactId: 'demo-artifact-frontend',
        title: 'Frontend persona handoff',
        instructions:
          'Inspect the dashboard preview artifact and apply the client revision request. Keep changes scoped to layout clarity.',
        agentType: WorkOrderAgentType.FRONTEND,
        status: WorkOrderStatus.DISPATCHED,
        priority: WorkOrderPriority.HIGH,
        createdById: pm.id,
        dispatchedAt: now,
      },
      {
        id: 'demo-work-order-backend',
        projectId,
        taskId: 'demo-task-backend-api',
        artifactId: 'demo-artifact-backend',
        title: 'Backend persona API review',
        instructions: 'Validate the backend endpoints involved in project delivery and note any contract gaps.',
        agentType: WorkOrderAgentType.BACKEND,
        status: WorkOrderStatus.READY,
        priority: WorkOrderPriority.NORMAL,
        createdById: pm.id,
      },
      {
        id: 'demo-work-order-architecture',
        projectId,
        taskId: 'demo-task-client-packaging',
        artifactId: 'demo-artifact-architecture',
        title: 'Architecture handoff summary',
        instructions: 'Summarize architecture decisions for the client-visible package.',
        agentType: WorkOrderAgentType.ARCHITECTURE,
        status: WorkOrderStatus.COMPLETED,
        priority: WorkOrderPriority.LOW,
        createdById: pm.id,
        dispatchedAt: twoHoursAgo,
        completedAt: oneHourAgo,
      },
    ],
  });

  await prisma.projectTimelineEvent.createMany({
    data: [
      {
        id: 'demo-timeline-project-created',
        projectId,
        actorId: pm.id,
        type: ProjectTimelineEventType.PROJECT_CREATED,
        visibility: ProjectTimelineVisibility.TEAM,
        title: 'Demo project created',
        body: 'Seeded project for persona testing.',
        metadata: { source: 'demo-seed' },
        createdAt: twoHoursAgo,
      },
      {
        id: 'demo-timeline-artifact-shared',
        projectId,
        actorId: pm.id,
        artifactId: 'demo-artifact-architecture',
        type: ProjectTimelineEventType.ARTIFACT_SHARED,
        visibility: ProjectTimelineVisibility.CLIENT,
        title: 'Architecture plan shared',
        body: 'Client-visible architecture artifact is ready for review.',
        metadata: { artifactId: 'demo-artifact-architecture' },
        createdAt: twoHoursAgo,
      },
      {
        id: 'demo-timeline-client-review',
        projectId,
        actorId: client.id,
        artifactId: 'demo-artifact-frontend',
        type: ProjectTimelineEventType.ARTIFACT_REVIEWED,
        visibility: ProjectTimelineVisibility.CLIENT,
        title: 'Client requested frontend revision',
        body: 'Please make the task list easier to scan before the next client review.',
        metadata: { reviewStatus: ArtifactReviewStatus.REVISION_REQUESTED },
        createdAt: now,
      },
      {
        id: 'demo-timeline-work-order',
        projectId,
        actorId: pm.id,
        taskId: 'demo-task-frontend-revision',
        artifactId: 'demo-artifact-frontend',
        type: ProjectTimelineEventType.WORK_ORDER_DISPATCHED,
        visibility: ProjectTimelineVisibility.TEAM,
        title: 'Frontend work order dispatched',
        body: 'Frontend persona handoff',
        metadata: { workOrderId: 'demo-work-order-frontend' },
        createdAt: now,
      },
      {
        id: 'demo-timeline-delivery-revision',
        projectId,
        actorId: client.id,
        type: ProjectTimelineEventType.DELIVERY_REVISION_REQUESTED,
        visibility: ProjectTimelineVisibility.CLIENT,
        title: 'Delivery revision requested',
        body: 'Please tighten the final handoff checklist before we accept delivery.',
        metadata: { deliveryReviewStatus: ProjectDeliveryReviewStatus.REVISION_REQUESTED },
        createdAt: now,
      },
    ],
  });

  await prisma.eventLog.createMany({
    data: [
      {
        id: 'demo-event-requirements',
        projectId,
        nodeName: 'requirements_parser',
        eventType: 'COMPLETED',
        costMeta: { inputTokens: 1200, outputTokens: 650, model: 'demo' },
        runTokens: 1850,
        occurredAt: twoHoursAgo,
      },
      {
        id: 'demo-event-frontend',
        projectId,
        nodeName: 'frontend_agent',
        eventType: 'STARTED',
        costMeta: { inputTokens: 2400, outputTokens: 0, model: 'demo' },
        runTokens: 48500,
        occurredAt: now,
      },
    ],
  });

  await prisma.notification.createMany({
    data: [
      {
        id: 'demo-notification-dev-task',
        recipientId: dev.id,
        actorId: pm.id,
        projectId,
        taskId: 'demo-task-frontend-revision',
        artifactId: 'demo-artifact-frontend',
        type: NotificationType.TASK_ASSIGNED,
        title: 'New frontend revision task',
        body: 'Revise dashboard task list',
        metadata: { source: 'demo-seed' },
        createdAt: oneHourAgo,
      },
      {
        id: 'demo-notification-dev-work-order',
        recipientId: dev.id,
        actorId: pm.id,
        projectId,
        taskId: 'demo-task-frontend-revision',
        artifactId: 'demo-artifact-frontend',
        type: NotificationType.WORK_ORDER_DISPATCHED,
        title: 'Work order dispatched',
        body: 'Frontend persona handoff',
        metadata: { workOrderId: 'demo-work-order-frontend' },
        createdAt: now,
      },
      {
        id: 'demo-notification-client-artifact',
        recipientId: client.id,
        actorId: pm.id,
        projectId,
        artifactId: 'demo-artifact-architecture',
        type: NotificationType.REVISION_HANDLED,
        title: 'Architecture plan ready',
        body: 'The architecture artifact is ready in your client view.',
        metadata: { source: 'demo-seed' },
        createdAt: twoHoursAgo,
      },
      {
        id: 'demo-notification-pm-delivery-revision',
        recipientId: pm.id,
        actorId: client.id,
        projectId,
        type: NotificationType.DELIVERY_REVISION_REQUESTED,
        title: 'Client requested delivery revisions',
        body: 'Please tighten the final handoff checklist before we accept delivery.',
        metadata: { source: 'demo-seed' },
        createdAt: now,
      },
    ],
  });

  await prisma.projectConversation.createMany({
    data: [
      {
        id: 'demo-conversation-client',
        projectId,
        title: 'Client review thread',
        category: ConversationCategory.DELIVERY,
        visibility: CollaborationVisibility.CLIENT,
        createdById: pm.id,
        lastMessageAt: now,
        createdAt: twoHoursAgo,
        updatedAt: now,
      },
      {
        id: 'demo-conversation-team',
        projectId,
        title: 'Developer implementation thread',
        category: ConversationCategory.GENERAL,
        visibility: CollaborationVisibility.TEAM,
        createdById: pm.id,
        lastMessageAt: now,
        createdAt: oneHourAgo,
        updatedAt: now,
      },
    ],
  });

  await prisma.projectMessage.createMany({
    data: [
      {
        id: 'demo-message-client-1',
        projectId,
        conversationId: 'demo-conversation-client',
        authorId: pm.id,
        body: 'The dashboard preview is ready for client review.',
        createdAt: oneHourAgo,
      },
      {
        id: 'demo-message-client-2',
        projectId,
        conversationId: 'demo-conversation-client',
        authorId: client.id,
        body: 'Please tighten the task list spacing before signoff.',
        createdAt: now,
      },
      {
        id: 'demo-message-team-1',
        projectId,
        conversationId: 'demo-conversation-team',
        authorId: pm.id,
        body: 'Client requested a dashboard density pass. Please coordinate with the frontend work order.',
        createdAt: now,
      },
    ],
  });

  await prisma.collaborationDocument.createMany({
    data: [
      {
        id: 'demo-document-contract',
        projectId,
        title: 'Demo scope agreement',
        description: 'Client-visible scope and acceptance checklist for the demo engagement.',
        fileName: 'demo-scope-agreement.pdf',
        kind: CollaborationDocumentKind.CONTRACT,
        status: CollaborationDocumentStatus.APPROVAL_REQUESTED,
        clientVisible: true,
        uploadedById: pm.id,
        createdAt: twoHoursAgo,
        updatedAt: twoHoursAgo,
      },
      {
        id: 'demo-document-brand-assets',
        projectId,
        title: 'Client brand assets',
        description: 'Seeded client upload record used by PM and client document views.',
        fileName: 'brand-assets.zip',
        kind: CollaborationDocumentKind.REQUIREMENT,
        status: CollaborationDocumentStatus.UPLOADED,
        clientVisible: true,
        uploadedById: client.id,
        createdAt: oneHourAgo,
        updatedAt: oneHourAgo,
      },
      {
        id: 'demo-document-internal-handoff',
        projectId,
        title: 'Internal implementation handoff',
        description: 'Team-only notes for developer delivery coordination.',
        fileName: 'internal-handoff.md',
        kind: CollaborationDocumentKind.GENERAL,
        status: CollaborationDocumentStatus.UPLOADED,
        clientVisible: false,
        uploadedById: pm.id,
        createdAt: now,
        updatedAt: now,
      },
    ],
  });

  console.log('');
  console.log('Demo persona project seeded successfully.');
  console.log(`Project ID: ${projectId}`);
  console.log(`PM: ${pm.email}`);
  console.log(`DEV: ${dev.email}`);
  console.log(`CLIENT: ${client.email}`);
  console.log('');
  console.log('Run npm run seed:demo:check to validate the seeded persona data shape.');
}

try {
  await seed();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
