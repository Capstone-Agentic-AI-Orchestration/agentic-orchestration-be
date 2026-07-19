import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DocumentExtractionService } from './document-extraction.service';
import { DocumentStorageService } from './document-storage.service';
import { IntakeController } from './intake.controller';
import { IntakeService } from './intake.service';

@Module({
  imports: [AuthModule, PrismaModule, NotificationsModule],
  controllers: [IntakeController],
  providers: [IntakeService, DocumentStorageService, DocumentExtractionService],
  exports: [IntakeService],
})
export class IntakeModule {}
