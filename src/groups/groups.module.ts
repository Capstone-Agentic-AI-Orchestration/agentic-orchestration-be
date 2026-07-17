import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GithubTeamsModule } from '../github/github-teams.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';

@Module({
  imports: [AuthModule, GithubTeamsModule, NotificationsModule],
  controllers: [GroupsController],
  providers: [GroupsService],
  exports: [GroupsService],
})
export class GroupsModule {}
