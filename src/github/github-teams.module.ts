import { Module } from '@nestjs/common';
import { GithubTeamsService } from './github-teams.service';

/**
 * Leaf module exposing {@link GithubTeamsService}. Deliberately has no imports
 * (ConfigModule is global) so AuthModule can depend on it without forming a
 * circular dependency with the AuthModule-importing GithubModule.
 */
@Module({
  providers: [GithubTeamsService],
  exports: [GithubTeamsService],
})
export class GithubTeamsModule {}
