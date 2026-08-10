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
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { executeIdempotentCommand } from '../shared/idempotency/idempotent-command';
import { IdempotencyService } from '../shared/idempotency/idempotency.service';
import { CursorPageInput } from '../shared/pagination/cursor-pagination';
import { CollaborationService, clientScope } from './collaboration.service';
import { CreateConversationDto, CreateMessageDto } from './dto/collaboration.dto';

/**
 * The conversation between a project manager and a client company.
 *
 * Separate from CollaborationController, which serves the same threads scoped to a project,
 * because the two have different guest lists rather than different data. DEV is absent here on
 * purpose: a developer belongs to a build, not to the commercial relationship, and the project
 * routes are where they talk to the project manager. Leaving DEV in would have been harmless for
 * CLIENT-visibility threads — the visibility filter drops those anyway — but would have handed
 * them the staff's private TEAM notes about the company.
 */
@Controller('clients/:clientId')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(UserRole.CLIENT, UserRole.PM, UserRole.ADMIN)
export class ClientConversationsController {
  constructor(
    private readonly collaborationService: CollaborationService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** Replays a repeated command with the same key instead of applying it twice. */
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

  @Get('conversations')
  listConversations(
    @Param('clientId') clientId: string,
    @CurrentUser() user: AuthUser,
    @Query() page?: CursorPageInput,
  ) {
    return this.collaborationService.listConversations(clientScope(clientId), user, page);
  }

  @Post('conversations')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  createConversation(
    @Param('clientId') clientId: string,
    @Body() dto: CreateConversationDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/clients/${clientId}/conversations`,
      dto,
      HttpStatus.CREATED,
      () => this.collaborationService.createConversation(clientScope(clientId), user, dto),
    );
  }

  @Get('conversations/:conversationId/messages')
  listMessages(
    @Param('clientId') clientId: string,
    @Param('conversationId') conversationId: string,
    @CurrentUser() user: AuthUser,
    @Query() page?: CursorPageInput,
  ) {
    return this.collaborationService.listMessages(clientScope(clientId), conversationId, user, page);
  }

  @Post('conversations/:conversationId/messages')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  addMessage(
    @Param('clientId') clientId: string,
    @Param('conversationId') conversationId: string,
    @Body() dto: CreateMessageDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/clients/${clientId}/conversations/${conversationId}/messages`,
      dto,
      HttpStatus.CREATED,
      () => this.collaborationService.addMessage(clientScope(clientId), conversationId, user, dto),
    );
  }

  @Patch('conversations/:conversationId/read')
  markConversationRead(
    @Param('clientId') clientId: string,
    @Param('conversationId') conversationId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/clients/${clientId}/conversations/${conversationId}/read`,
      { clientId, conversationId },
      HttpStatus.OK,
      () => this.collaborationService.markConversationRead(clientScope(clientId), conversationId, user),
    );
  }
}
