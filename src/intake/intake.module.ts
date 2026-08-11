import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DocumentExtractionService } from './document-extraction.service';
import { DocumentStorageService } from './document-storage.service';
import { ExtractionRecoveryService } from './extraction-recovery.service';
import { ClientBffController } from './client-bff.controller';
import { IntakeController } from './intake.controller';
import { IntakeDraftService } from './intake-draft.service';
import { IntakeInterviewService } from './intake-interview.service';
import { IntakeService } from './intake.service';

@Module({
  // OrchestrationModule for AgentLlmRouter only. Safe to import: nothing in the orchestration
  // dependency tree imports IntakeModule, so this introduces no cycle.
  imports: [AuthModule, PrismaModule, NotificationsModule, OrchestrationModule],
  controllers: [IntakeController, ClientBffController],
  // ExtractionRecoveryService carries an @Interval, activated by the root ScheduleModule.forRoot().
  providers: [IntakeService, IntakeDraftService, IntakeInterviewService, DocumentStorageService, DocumentExtractionService, ExtractionRecoveryService],
  exports: [IntakeService],
})
export class IntakeModule {}
