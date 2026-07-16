import { Injectable, Logger } from '@nestjs/common';
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
          repository: {
            select: { id: true, name: true, htmlUrl: true, cloneUrl: true, status: true },
          },
        },
      });
      if (!project) throw new Error(`Project ${state.projectId} not found`);

      let repoName = project.repository?.name;
      let repoUrl = project.repository?.htmlUrl ?? project.repository?.cloneUrl ?? project.repoUrl;

      // Reuse the plain repository created by the PM flow. Older projects can
      // still be provisioned here, but no CI/CD files are ever added.
      if (!repoName || !repoUrl) {
        repoName = this.github.buildRepoName(state.companyName, state.projectId);
        const remote = await this.github.createPlainRepository(
          repoName,
          `${state.companyName} workspace created by DevFlow`,
        );
        repoUrl = remote.htmlUrl;
        if (project.groupId && project.createdById) {
          await this.prisma.repository.upsert({
            where: { projectId: state.projectId },
            update: {
              name: remote.name,
              fullName: remote.fullName,
              htmlUrl: remote.htmlUrl,
              cloneUrl: remote.cloneUrl,
              defaultBranch: remote.defaultBranch,
              visibility: remote.visibility,
              status: 'ACTIVE',
              lastError: null,
              provisionedAt: new Date(),
            },
            create: {
              projectId: state.projectId,
              groupId: project.groupId,
              createdById: project.createdById,
              name: remote.name,
              fullName: remote.fullName,
              htmlUrl: remote.htmlUrl,
              cloneUrl: remote.cloneUrl,
              defaultBranch: remote.defaultBranch,
              visibility: remote.visibility,
              status: 'ACTIVE',
              provisionedAt: new Date(),
            },
          });
        }
        this.logger.log(`[${state.projectId}] Plain repository created: ${repoUrl}`);
      } else {
        this.logger.log(`[${state.projectId}] Reusing repository: ${repoUrl}`);
      }

      // Commit generated artifacts into the existing plain repository.
      const commitMessage = `feat: initial scaffold by DevFlow [run:${state.runId}]`;
      await this.github.commitFiles(
        repoName,
        state.artifacts.map((a) => ({
          filePath: a.filePath,
          content: a.content,
        })),
        commitMessage,
      );
      this.logger.log(
        `[${state.projectId}] Committed ${state.artifacts.length} files`,
      );

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
