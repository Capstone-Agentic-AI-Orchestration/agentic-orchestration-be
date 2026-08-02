import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClientsModule } from '../clients/clients.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { InquiriesController } from './inquiries.controller';
import { InquiriesService } from './inquiries.service';
import { IntakeRepository } from './intake.repository';
import { ClientAccountInvitationService } from './client-account-invitation.service';

@Module({
  imports: [PrismaModule, NotificationsModule, AuthModule, ClientsModule],
  controllers: [InquiriesController],
  providers: [IntakeRepository, ClientAccountInvitationService, InquiriesService],
  exports: [IntakeRepository],
})
export class InquiriesModule {}
