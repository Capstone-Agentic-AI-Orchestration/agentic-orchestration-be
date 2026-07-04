import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ClientInviteStatus, InquiryStatus, PrismaClient, ProjectDeliveryReviewStatus, ProjectKickoffStatus, ProjectTimelineVisibility, UserRole } from '@prisma/client';

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

function assertCheck(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

loadEnvFile();

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Check devflow-be/.env.');
  process.exit(1);
}

const prisma = new PrismaClient();
const projectId = process.env.DEMO_PROJECT_ID ?? 'demo-persona-project';

async function check() {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      createdBy: true,
      members: { include: { user: true } },
      artifacts: true,
      tasks: { include: { assignedTo: true } },
      workOrders: { include: { task: true } },
      timelineEvents: true,
      kickoff: true,
      deliveryReview: true,
    },
  });

  assertCheck(project, `Demo project ${projectId} was not found. Run npm run seed:demo first.`);

  const pm = project.createdBy;
  const devMember = project.members.find((member) => member.role === UserRole.DEV);
  const clientMember = project.members.find((member) => member.role === UserRole.CLIENT);

  assertCheck(pm?.role === UserRole.PM, 'Demo project creator must be a PM profile.');
  assertCheck(devMember, 'Demo project must have a DEV member.');
  assertCheck(clientMember, 'Demo project must have a CLIENT member.');
  assertCheck(project.kickoff?.status === ProjectKickoffStatus.READY, 'Demo project kickoff should be ready.');
  assertCheck(project.deliveryReview?.status === ProjectDeliveryReviewStatus.REVISION_REQUESTED, 'Demo project should include an open project-level delivery revision.');
  assertCheck(project.kickoff?.initialTasksCreated, 'Demo project kickoff should mark starter tasks created.');
  assertCheck(project.kickoff?.initialWorkOrdersCreated, 'Demo project kickoff should mark starter work orders created.');

  const pmArtifacts = project.artifacts;
  const clientArtifacts = project.artifacts.filter((artifact) => artifact.clientVisible);
  const openRevisionArtifacts = clientArtifacts.filter((artifact) => artifact.reviewStatus === 'REVISION_REQUESTED' && !artifact.revisionHandledAt);
  const devTasks = project.tasks.filter((task) => task.assignedToId === devMember.userId);
  const devWorkOrders = project.workOrders.filter((workOrder) => workOrder.task?.assignedToId === devMember.userId);
  const clientTimeline = project.timelineEvents.filter((event) => event.visibility === ProjectTimelineVisibility.CLIENT);
  const teamTimeline = project.timelineEvents.filter((event) => event.visibility !== ProjectTimelineVisibility.INTERNAL);
  const devProjects = await prisma.project.findMany({
    where: {
      id: projectId,
      OR: [
        { createdById: devMember.userId },
        { members: { some: { userId: devMember.userId } } },
      ],
    },
    select: { id: true },
  });
  const clientProjects = await prisma.project.findMany({
    where: {
      id: projectId,
      OR: [
        { createdById: clientMember.userId },
        { members: { some: { userId: clientMember.userId } } },
      ],
    },
    select: { id: true },
  });
  const devVisibleTasks = await prisma.projectTask.findMany({
    where: { projectId, assignedToId: devMember.userId },
    select: { id: true },
  });
  const devVisibleWorkOrders = await prisma.workOrder.findMany({
    where: { projectId, task: { assignedToId: devMember.userId } },
    select: { id: true },
  });
  const clientVisibleArtifacts = await prisma.artifact.findMany({
    where: { projectId, clientVisible: true },
    select: { id: true },
  });
  const clientVisibleTimeline = await prisma.projectTimelineEvent.findMany({
    where: { projectId, visibility: { in: [ProjectTimelineVisibility.CLIENT] } },
    select: { id: true },
  });

  const devNotifications = await prisma.notification.count({
    where: { projectId, recipientId: devMember.userId },
  });
  const clientNotifications = await prisma.notification.count({
    where: { projectId, recipientId: clientMember.userId },
  });
  const demoInquiries = await prisma.clientInquiry.findMany({
    where: { id: { in: ['demo-inquiry-new', 'demo-inquiry-approved', 'demo-inquiry-rejected'] } },
    select: { id: true, status: true, approvedProjectId: true },
  });
  const acceptedInvite = await prisma.clientInvite.findUnique({
    where: { id: 'demo-client-invite-accepted' },
    select: { status: true, acceptedById: true, projectId: true },
  });

  assertCheck(pmArtifacts.length >= 3, 'PM should have at least 3 project artifacts.');
  assertCheck(clientArtifacts.length >= 2, 'Client should have at least 2 client-visible artifacts.');
  assertCheck(openRevisionArtifacts.length >= 1, 'Demo seed should include an open client revision signal for lifecycle derivation.');
  assertCheck(devTasks.length >= 2, 'Developer should have at least 2 assigned tasks.');
  assertCheck(devWorkOrders.length >= 2, 'Developer should have at least 2 task-linked work orders.');
  assertCheck(clientTimeline.length >= 2, 'Client timeline should have at least 2 client-visible events.');
  assertCheck(teamTimeline.length >= clientTimeline.length, 'Team timeline should include client-visible events.');
  assertCheck(devProjects.length === 1, 'Developer should have member access to the demo project.');
  assertCheck(clientProjects.length === 1, 'Client should have member access to the demo project.');
  assertCheck(devVisibleTasks.length === devTasks.length, 'Developer task smoke query should match assigned tasks only.');
  assertCheck(devVisibleWorkOrders.length === devWorkOrders.length, 'Developer work-order smoke query should match task-linked work orders only.');
  assertCheck(clientVisibleArtifacts.length === clientArtifacts.length, 'Client artifact smoke query should match client-visible artifacts only.');
  assertCheck(clientVisibleTimeline.length === clientTimeline.length, 'Client timeline smoke query should match client-visible timeline only.');
  assertCheck(devNotifications >= 2, 'Developer should have at least 2 notifications.');
  assertCheck(clientNotifications >= 1, 'Client should have at least 1 notification.');
  assertCheck(demoInquiries.length === 3, 'Demo seed should include 3 client inquiries.');
  assertCheck(demoInquiries.some((inquiry) => inquiry.status === InquiryStatus.NEW), 'Demo seed should include a NEW inquiry.');
  assertCheck(demoInquiries.some((inquiry) => inquiry.status === InquiryStatus.APPROVED && inquiry.approvedProjectId === projectId), 'Demo seed should include an approved inquiry linked to the demo project.');
  assertCheck(acceptedInvite?.status === ClientInviteStatus.ACCEPTED, 'Demo seed should include an accepted client invite.');
  assertCheck(acceptedInvite?.acceptedById === clientMember.userId, 'Accepted demo invite should be tied to the demo client profile.');

  console.log('Demo persona checks passed.');
  console.table([
    { persona: 'PM', email: pm.email, project: project.id, artifacts: pmArtifacts.length, tasks: project.tasks.length, workOrders: project.workOrders.length, kickoff: project.kickoff.status, deliveryReview: project.deliveryReview.status, inquiries: demoInquiries.length, invites: acceptedInvite ? 1 : 0 },
    { persona: 'DEV', email: devMember.user.email, project: project.id, tasks: devVisibleTasks.length, workOrders: devVisibleWorkOrders.length, notifications: devNotifications },
    { persona: 'CLIENT', email: clientMember.user.email, project: project.id, artifacts: clientVisibleArtifacts.length, timeline: clientVisibleTimeline.length, notifications: clientNotifications },
  ]);
}

try {
  await check();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
