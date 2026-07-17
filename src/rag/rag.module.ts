import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GatewayModule } from '../gateway/gateway.module';
import { ContextMemoryModule } from '../context-memory/context-memory.module';
import { MemoryModule } from '../memory/memory.module';
import { RagAccessService } from './rag-access.service';
import { RagAuditService } from './rag-audit.service';
import { RagContextPackBuilderService } from './rag-context-pack-builder.service';
import { RagController } from './rag.controller';
import { ContextCompressorService } from './context-compressor.service';
import { ContextEngineService } from './context-engine.service';
import { ContextRankerService } from './context-ranker.service';
import { HybridSearchService } from './hybrid-search.service';
import { RagIndexingService } from './rag-indexing.service';
import { RagRetrievalService } from './rag-retrieval.service';

@Module({
  imports: [AuthModule, MemoryModule, ContextMemoryModule, GatewayModule],
  controllers: [RagController],
  providers: [
    RagAccessService,
    RagAuditService,
    RagIndexingService,
    HybridSearchService,
    ContextRankerService,
    RagRetrievalService,
    ContextCompressorService,
    RagContextPackBuilderService,
    ContextEngineService,
  ],
  exports: [RagIndexingService, RagRetrievalService, RagContextPackBuilderService, ContextEngineService],
})
export class RagModule {}
