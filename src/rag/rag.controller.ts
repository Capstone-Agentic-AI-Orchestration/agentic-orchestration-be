import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { executeIdempotentCommand } from '../shared/idempotency/idempotent-command';
import { IdempotencyService } from '../shared/idempotency/idempotency.service';
import { ContextEngineService } from './context-engine.service';
import { RagAccessService } from './rag-access.service';
import { RagChunkListDto, RagContextPackDto, RagReindexSourceDto, RagSearchDto } from './dto/rag.dto';
import { RagIndexingService } from './rag-indexing.service';
import { RagRetrievalService } from './rag-retrieval.service';

@Controller('projects/:projectId/rag')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class RagController {
  constructor(
    private readonly access: RagAccessService,
    private readonly indexer: RagIndexingService,
    private readonly retrieval: RagRetrievalService,
    private readonly contextEngine: ContextEngineService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private runIdempotent<T>(key: string | undefined, scope: string, payload: unknown, status: number, handler: () => Promise<T>): Promise<T> {
    return executeIdempotentCommand({ idempotency: this.idempotency, idempotencyKey: key, scope, requestPayload: payload, responseStatus: status, handler });
  }

  @Post('index')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  index(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser, @Headers('idempotency-key') key?: string) {
    return this.runIdempotent(key, `user:${user.id}:POST:/projects/${projectId}/rag/index`, {}, HttpStatus.OK, async () => {
      await this.access.assertProjectAccess(projectId, user);
      return this.indexer.indexProject(projectId);
    });
  }

  @Post('search')
  @Roles(UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  search(@Param('projectId') projectId: string, @Body() dto: RagSearchDto, @CurrentUser() user: AuthUser, @Headers('idempotency-key') key?: string) {
    return this.runIdempotent(key, `user:${user.id}:POST:/projects/${projectId}/rag/search`, dto, HttpStatus.OK, async () => {
      const safeSourceTypes = await this.access.assertProjectAccess(projectId, user, true);
      const sourceTypes = safeSourceTypes
        ? (dto.sourceTypes ?? safeSourceTypes).filter((type) => safeSourceTypes.includes(type))
        : dto.sourceTypes;
      return this.retrieval.retrieve({ projectId, query: dto.query, agentName: dto.agentName ?? 'rag_preview', runId: dto.runId, workOrderId: dto.workOrderId, workOrderExecutionId: dto.workOrderExecutionId, sourceTypes, tags: dto.tags, limit: dto.limit, useKeyword: dto.useKeyword, useVector: dto.useVector });
    });
  }

  @Post('context-pack')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  contextPack(@Param('projectId') projectId: string, @Body() dto: RagContextPackDto, @CurrentUser() user: AuthUser, @Headers('idempotency-key') key?: string) {
    return this.runIdempotent(key, `user:${user.id}:POST:/projects/${projectId}/rag/context-pack`, dto, HttpStatus.OK, async () => {
      await this.access.assertProjectAccess(projectId, user);
      return this.contextEngine.buildContextPack({ projectId, runId: dto.runId, workOrderId: dto.workOrderId, workOrderExecutionId: dto.workOrderExecutionId, agentName: dto.agentName, query: dto.currentTask, currentTask: dto.currentTask, maxContextChars: dto.maxContextChars });
    });
  }

  @Post('reindex-source')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  reindexSource(@Param('projectId') projectId: string, @Body() dto: RagReindexSourceDto, @CurrentUser() user: AuthUser, @Headers('idempotency-key') key?: string) {
    return this.runIdempotent(key, `user:${user.id}:POST:/projects/${projectId}/rag/reindex-source`, dto, HttpStatus.OK, async () => {
      await this.access.assertProjectAccess(projectId, user);
      return this.indexer.reindexSource(projectId, dto.sourceType, dto.sourceId);
    });
  }

  @Get('chunks')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async chunks(@Param('projectId') projectId: string, @Query() query: RagChunkListDto, @CurrentUser() user: AuthUser) {
    await this.access.assertProjectAccess(projectId, user);
    return this.indexer.listChunks(projectId, query.sourceType, query.agentName, query.limit);
  }
}
