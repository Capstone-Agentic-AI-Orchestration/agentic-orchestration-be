import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { InquiriesController } from './inquiries.controller';
import { InquiriesService } from './inquiries.service';
import { IntakeRepository } from './intake.repository';

@Module({
  imports: [PrismaModule, NotificationsModule, AuthModule],
  controllers: [InquiriesController],
  providers: [IntakeRepository, InquiriesService],
  exports: [IntakeRepository],
})
export class InquiriesModule {}
