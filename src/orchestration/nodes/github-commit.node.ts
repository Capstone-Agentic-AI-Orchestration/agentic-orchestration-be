import { Injectable, Logger } from '@nestjs/common';
import { RepositoryKind } from '@prisma/client';
import { GithubService } from '../../github/github.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DevFlowStateType } from '../graph/devflow.state';

// ─── Node ─────────────────────────────────────────────────────────────────────

@Injectable()
export class GithubCommitNode {
  private readonly logger = new Logger(GithubCommitNode.name);

  constructor(
    private readonly github: GithubService,
    private readonly prisma: PrismaService,
  ) {}

  async execute(
    state: DevFlowStateType,
  ): Promise<Partial<DevFlowStateType>> {
    this.logger.log(`[${state.projectId}] Committing artifacts to GitHub`);

    try {
      await this.prisma.project.update({
        where: { id: state.projectId },
        data: { status: 'COMMITTING' },
      });

      const project = await this.prisma.project.findUnique({
        where: { id: state.projectId },
        select: {
          createdById: true,
          groupId: true,
          repoUrl: true,
          repositories: {
            select: { id: true, name: true, htmlUrl: true, cloneUrl: true, status: true, kind: true },
          },
        },
      });
      if (!project) throw new Error(`Project ${state.projectId} not found`);

      // Repos are provisioned deterministically at project creation (with the
      // .gitignore + config + MVVM scaffold). We never create a repo here — the
      // agents only produce feature code, which we route to the matching repo.
      if (project.repositories.length === 0) {
        throw new Error(
          `Project ${state.projectId} has no provisioned repositories; create the project's repositories first.`,
        );
      }
      const repoByKind = new Map(project.repositories.map((repo) => [repo.kind, repo]));

      // Frontend code -> frontend repo; everything else -> backend repo. Fall
      // back to backend when a kind's repo wasn't provisioned.
      const targetKind = (agentType: string): RepositoryKind => {
        const wanted = agentType === 'frontend' ? RepositoryKind.FRONTEND : RepositoryKind.BACKEND;
        return repoByKind.has(wanted) ? wanted : RepositoryKind.BACKEND;
      };

      const byRepo = new Map<RepositoryKind, typeof state.artifacts>();
      for (const artifact of state.artifacts) {
        const kind = targetKind(artifact.agentType);
        if (!repoByKind.has(kind)) continue;
        const list = byRepo.get(kind) ?? [];
        list.push(artifact);
        byRepo.set(kind, list);
      }

      const commitMessage = `feat: generated code by DevFlow [run:${state.runId}]`;
      for (const [kind, artifacts] of byRepo) {
        const repo = repoByKind.get(kind)!;
        await this.github.commitFiles(
          repo.name,
          artifacts.map((a) => ({ filePath: a.filePath, content: a.content })),
          commitMessage,
        );
        this.logger.log(`[${state.projectId}] Committed ${artifacts.length} files to ${repo.name} (${kind})`);
      }

      const primaryRepo =
        repoByKind.get(RepositoryKind.BACKEND) ?? project.repositories[0];
      const repoUrl = primaryRepo?.htmlUrl ?? primaryRepo?.cloneUrl ?? project.repoUrl;

      // Persist artifacts to DB.
      if (state.artifacts.length > 0) {
        await this.prisma.artifact.createMany({
          data: state.artifacts.map((a) => ({
            projectId: state.projectId,
            agentType: a.agentType,
            filePath: a.filePath,
            content: a.content,
          })),
          skipDuplicates: true,
        });
      }

      // Update project with repository URL.
      await this.prisma.project.update({
        where: { id: state.projectId },
        data: { repoUrl },
      });

      this.logger.log(`[${state.projectId}] GitHub commit complete: ${repoUrl}`);

      return { repoUrl };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${state.projectId}] GitHub commit failed: ${message}`);

      await this.prisma.project
        .update({
          where: { id: state.projectId },
          data: { status: 'FAILED' },
        })
        .catch(() => undefined);

      return { error: `GithubCommitNode failed: ${message}` };
    }
  }
}
