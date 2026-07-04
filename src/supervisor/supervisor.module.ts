import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EventLogService } from './event-log.service';
import { RunSupervisorService } from './run-supervisor.service';
import { OrchestrationModule } from '../orchestration/orchestration.module';

/**
 * SupervisorModule — bundles EventLogService and RunSupervisorService.
 *
 * ScheduleModule.forRoot() is registered in AppModule (the canonical location).
 * The @Interval decorator on RunSupervisorService.supervisorTick() is activated
 * by that single AppModule registration — no duplicate forRoot() call is needed
 * here.
 *
 * PrismaModule is @Global() so the import here is technically redundant. The
 * forwardRef import lets RunSupervisorService delegate recovery execution back
 * to OrchestrationService without moving agent execution into the supervisor.
 */
@Module({
  imports: [PrismaModule, forwardRef(() => OrchestrationModule)],
  providers: [EventLogService, RunSupervisorService],
  exports: [EventLogService, RunSupervisorService],
})
export class SupervisorModule {}
