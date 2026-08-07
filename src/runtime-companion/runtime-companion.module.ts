import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RuntimeCompanionController } from './runtime-companion.controller';
import { MachinesController } from './machines.controller';
import { RuntimeCompanionService } from './runtime-companion.service';
import { RuntimeTaskService } from './runtime-task.service';
import { RuntimeTaskReaperService } from './runtime-task-reaper.service';
import { RuntimeTokenService } from './runtime-token.service';
import { RuntimeTokenGuard } from './runtime-token.guard';
import { RuntimeGateway } from './runtime.gateway';

/**
 * Server half of the `devflow-runtime` companion daemon.
 *
 * `AuthModule` is imported for the browser-facing machine routes, which still use the normal
 * Supabase session; the daemon routes authenticate on their own machine token instead. `PrismaModule`
 * is global, so it needs no import here.
 */
@Module({
  imports: [AuthModule],
  controllers: [RuntimeCompanionController, MachinesController],
  providers: [
    RuntimeCompanionService,
    RuntimeTaskService,
    RuntimeTaskReaperService,
    RuntimeTokenService,
    RuntimeTokenGuard,
    RuntimeGateway,
  ],
  exports: [RuntimeCompanionService, RuntimeTaskService, RuntimeGateway],
})
export class RuntimeCompanionModule {}
