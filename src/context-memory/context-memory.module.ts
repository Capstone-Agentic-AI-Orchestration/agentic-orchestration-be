import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ContextMemoryController } from './context-memory.controller';
import { ContextMemoryService } from './context-memory.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ContextMemoryController],
  providers: [ContextMemoryService],
  exports: [ContextMemoryService],
})
export class ContextMemoryModule {}
