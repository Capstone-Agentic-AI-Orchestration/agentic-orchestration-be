import { Module } from '@nestjs/common';
import { GithubService } from './github.service';
import { GithubController } from './github.controller';
import { AuthModule } from '../auth/auth.module';
import { GroupsModule } from '../groups/groups.module';

@Module({
  imports: [AuthModule, GroupsModule],
  controllers: [GithubController],
  providers: [GithubService],
  exports: [GithubService],
})
export class GithubModule {}
