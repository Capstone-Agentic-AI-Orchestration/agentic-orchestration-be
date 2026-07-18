import { Module } from '@nestjs/common';
import { AgentRepoService } from './agent-repo.service';
import { AgentRepoController } from './agent-repo.controller';
import { GithubModule } from '../github/github.module';

/**
 * Leaf module: depends only on GithubModule (and the global PrismaModule), so the orchestration
 * layer can inject AgentRepoService without creating a circular dependency.
 */
@Module({
  imports: [GithubModule],
  controllers: [AgentRepoController],
  providers: [AgentRepoService],
  exports: [AgentRepoService],
})
export class AgentRepoModule {}
