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

      const repoName = this.github.buildRepoName(
        state.companyName,
        state.projectId,
      );

      // 1. Create the repository
      const repoUrl = await this.github.createRepo(repoName);
      this.logger.log(`[${state.projectId}] Repository created: ${repoUrl}`);

      // 2. Commit all generated artifacts
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

      // 3. Inject CI workflow (non-fatal)
      await this.github.injectCiWorkflow(repoName).catch((err: unknown) => {
        this.logger.warn(`[${state.projectId}] CI workflow injection skipped: ${err instanceof Error ? err.message : err}`);
      });
      this.logger.log(`[${state.projectId}] CI workflow injected`);

      // 4. Persist artifacts to DB
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

      // 5. Update project with repo URL
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
