import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { executeIdempotentCommand } from '../shared/idempotency/idempotent-command';
import { IdempotencyService } from '../shared/idempotency/idempotency.service';
import {
  BuildContextPackDto,
  CompactContextMemoryDto,
  CreateContextHandoffDto,
  ListContextHandoffsDto,
  ListContextSnapshotsDto,
  RecordContextMemoryDto,
  SearchContextMemoryDto,
} from './dto/context-memory.dto';
import { ContextMemoryService } from './context-memory.service';

@Controller('memory')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('PM' as UserRole, 'DEV' as UserRole, 'ADMIN' as UserRole)
export class ContextMemoryController {
  constructor(
    private readonly contextMemory: ContextMemoryService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private runIdempotent<TBody>(
    idempotencyKey: string | undefined,
    scope: string,
    requestPayload: unknown,
    responseStatus: number,
    handler: () => Promise<TBody>,
  ): Promise<TBody> {
    return executeIdempotentCommand({
      idempotency: this.idempotency,
      idempotencyKey,
      scope,
      requestPayload,
      responseStatus,
      handler,
    });
  }

  @Post('events')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  record(
    @Body() dto: RecordContextMemoryDto,
    @CurrentUser() user?: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user?.id ?? 'system'}:POST:/memory/events`,
      dto,
      HttpStatus.CREATED,
      () => this.contextMemory.record(dto),
    );
  }

  @Post('context-pack')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  buildContextPack(
    @Body() dto: BuildContextPackDto,
    @CurrentUser() user?: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user?.id ?? 'system'}:POST:/memory/context-pack`,
      dto,
      HttpStatus.OK,
      () => this.contextMemory.buildContextPack(dto),
    );
  }

  @Post('search')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  search(
    @Body() dto: SearchContextMemoryDto,
    @CurrentUser() user?: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user?.id ?? 'system'}:POST:/memory/search`,
      dto,
      HttpStatus.OK,
      () => this.contextMemory.search(dto),
    );
  }

  @Post('handoffs')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  createHandoff(
    @Body() dto: CreateContextHandoffDto,
    @CurrentUser() user?: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user?.id ?? 'system'}:POST:/memory/handoffs`,
      dto,
      HttpStatus.CREATED,
      () => this.contextMemory.createHandoff(dto),
    );
  }

  @Patch('handoffs/:handoffId/ack')
  @HttpCode(HttpStatus.OK)
  acknowledgeHandoff(
    @Param('handoffId') handoffId: string,
    @CurrentUser() user?: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user?.id ?? 'system'}:PATCH:/memory/handoffs/:handoffId/ack`,
      { handoffId },
      HttpStatus.OK,
      () => this.contextMemory.acknowledgeHandoff(handoffId),
    );
  }

  @Patch('handoffs/:handoffId/resolve')
  @HttpCode(HttpStatus.OK)
  resolveHandoff(
    @Param('handoffId') handoffId: string,
    @CurrentUser() user?: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user?.id ?? 'system'}:PATCH:/memory/handoffs/:handoffId/resolve`,
      { handoffId },
      HttpStatus.OK,
      () => this.contextMemory.resolveHandoff(handoffId),
    );
  }

  @Post('compact')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  compactProjectMemory(
    @Body() dto: CompactContextMemoryDto,
    @CurrentUser() user?: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user?.id ?? 'system'}:POST:/memory/compact`,
      dto,
      HttpStatus.OK,
      () => this.contextMemory.compactProjectMemory(dto),
    );
  }

  @Get('projects/:projectId/events')
  listProjectEvents(
    @Param('projectId') projectId: string,
    @Query() query: Omit<SearchContextMemoryDto, 'projectId'>,
  ) {
    return this.contextMemory.list({
      ...query,
      projectId,
    });
  }

  @Get('projects/:projectId/timeline')
  listProjectTimeline(
    @Param('projectId') projectId: string,
    @Query() query: Omit<SearchContextMemoryDto, 'projectId'>,
  ) {
    return this.contextMemory.list({
      ...query,
      projectId,
    });
  }

  @Get('projects/:projectId/handoffs')
  listProjectHandoffs(
    @Param('projectId') projectId: string,
    @Query() query: ListContextHandoffsDto,
  ) {
    return this.contextMemory.listHandoffs({
      ...query,
      projectId,
    });
  }

  @Get('projects/:projectId/snapshots')
  listProjectSnapshots(
    @Param('projectId') projectId: string,
    @Query() query: ListContextSnapshotsDto,
  ) {
    return this.contextMemory.listSnapshots({
      ...query,
      projectId,
    });
  }
}
