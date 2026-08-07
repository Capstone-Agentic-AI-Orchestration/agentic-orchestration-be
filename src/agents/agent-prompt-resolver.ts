import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const logger = new Logger('AgentPromptResolver');

/**
 * The system prompt an agent should actually be sent.
 *
 * The orchestration nodes used to pass their compiled-in constant straight into
 * `buildAgentSystemPrompt`, which meant the console's Instructions field could describe an agent
 * but never change one. They call this instead: the workspace's override wins when it exists,
 * the built-in is used when it does not, and the workspace's attached skills are appended either
 * way so a convention taught once reaches every agent that has it.
 *
 * Deliberately a function over PrismaService rather than a method on AgentsService: the nodes
 * already hold Prisma, so this needs no new injection and cannot introduce a module cycle
 * between orchestration and agents.
 *
 * Every failure path returns the fallback. A misconfigured or unreachable agent row must
 * degrade a run to the built-in behaviour, never stop it — the run is worth more than the
 * customisation.
 */
export async function resolveAgentSystemPrompt(
  prisma: PrismaService,
  projectId: string,
  agentKey: string,
  fallback: string,
): Promise<string> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { groupId: true },
    });
    if (!project?.groupId) return fallback;

    const agent = await prisma.workspaceAgent.findUnique({
      where: { groupId_key: { groupId: project.groupId, key: agentKey } },
      include: { skills: { include: { skill: true }, orderBy: { createdAt: 'asc' } } },
    });
    if (!agent) return fallback;

    const base = agent.instructions?.trim() || fallback;
    if (agent.skills.length === 0) return base;

    // Appended, never substituted. A skill teaches a convention on top of the role; letting one
    // silently replace the role would be a foot-gun with no warning at the point of authoring.
    const skillBlock = agent.skills
      .map((link) => `### ${link.skill.name}\n${link.skill.body.trim()}`)
      .join('\n\n');
    return `${base}\n\n## Skills\n${skillBlock}`;
  } catch (error) {
    logger.warn(
      `Falling back to the built-in prompt for "${agentKey}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return fallback;
  }
}
