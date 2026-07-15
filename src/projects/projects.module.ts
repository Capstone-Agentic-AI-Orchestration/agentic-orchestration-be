import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { IntakeModule } from '../intake/intake.module';

@Module({
  imports: [AuthModule, OrchestrationModule, NotificationsModule, IntakeModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
