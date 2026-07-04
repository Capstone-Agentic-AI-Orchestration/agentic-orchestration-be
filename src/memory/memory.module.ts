import { Module } from '@nestjs/common';
import { EmbeddingService } from './embedding.service';
import { MemoryService } from './memory.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [EmbeddingService, MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
