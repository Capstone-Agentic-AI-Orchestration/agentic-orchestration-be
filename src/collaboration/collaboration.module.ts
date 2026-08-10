import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ClientConversationsController } from './client-conversations.controller';
import { CollaborationController } from './collaboration.controller';
import { CollaborationService } from './collaboration.service';

@Module({
  imports: [AuthModule, PrismaModule, NotificationsModule],
  controllers: [CollaborationController, ClientConversationsController],
  providers: [CollaborationService],
  exports: [CollaborationService],
})
export class CollaborationModule {}
