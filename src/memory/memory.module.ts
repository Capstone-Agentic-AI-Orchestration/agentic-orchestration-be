import { Module } from '@nestjs/common';
import { EmbeddingService } from './embedding.service';
import { MemoryService } from './memory.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ContextMemoryModule } from '../context-memory/context-memory.module';

@Module({
  imports: [PrismaModule, ContextMemoryModule],
  providers: [EmbeddingService, MemoryService],
  exports: [MemoryService, EmbeddingService],
})
export class MemoryModule {}
