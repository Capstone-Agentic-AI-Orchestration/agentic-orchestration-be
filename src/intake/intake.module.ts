import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DocumentExtractionService } from './document-extraction.service';
import { DocumentStorageService } from './document-storage.service';
import { ExtractionRecoveryService } from './extraction-recovery.service';
import { IntakeController } from './intake.controller';
import { IntakeService } from './intake.service';

@Module({
  imports: [AuthModule, PrismaModule, NotificationsModule],
  controllers: [IntakeController],
  // ExtractionRecoveryService carries an @Interval, activated by the root ScheduleModule.forRoot().
  providers: [IntakeService, DocumentStorageService, DocumentExtractionService, ExtractionRecoveryService],
  exports: [IntakeService],
})
export class IntakeModule {}
