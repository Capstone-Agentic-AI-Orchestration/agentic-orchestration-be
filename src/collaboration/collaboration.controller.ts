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
import { CollaborationService } from './collaboration.service';
import {
  CreateCollaborationDocumentDto,
  ReviewCollaborationDocumentDto,
  UpdateCollaborationDocumentDto,
} from './dto/collaboration.dto';

/**
 * A project's client documents.
 *
 * Conversations used to live here too, on two footings: CLIENT threads with the company and TEAM
 * threads between developers and the project manager. Both are gone. The company conversation moved
 * to the client, which owns the relationship, and the developer-to-project-manager channel was
 * removed rather than moved — delivery talk belongs on the issues and work orders it is about, and a
 * second inbox nobody was obliged to read was worse than no inbox at all.
 *
 * Documents stay project-scoped: a requirements brief is uploaded for one build.
 */
@Controller('projects/:projectId')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class CollaborationController {
  constructor(
    private readonly collaborationService: CollaborationService,
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

  @Get('documents')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  listDocuments(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
    @Query() page?: CursorPageInput,
  ) {
    return this.collaborationService.listDocuments(projectId, user, page);
  }

  @Post('documents')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  createDocument(
    @Param('projectId') projectId: string,
    @Body() dto: CreateCollaborationDocumentDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/projects/${projectId}/documents`,
      dto,
      HttpStatus.CREATED,
      () => this.collaborationService.createDocument(projectId, user, dto),
    );
  }

  @Patch('documents/:documentId')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  updateDocument(
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
    @Body() dto: UpdateCollaborationDocumentDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/projects/${projectId}/documents/${documentId}`,
      dto,
      HttpStatus.OK,
      () => this.collaborationService.updateDocument(projectId, documentId, user, dto),
    );
  }

  @Post('documents/:documentId/review')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  reviewDocument(
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
    @Body() dto: ReviewCollaborationDocumentDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/projects/${projectId}/documents/${documentId}/review`,
      dto,
      HttpStatus.OK,
      () => this.collaborationService.reviewDocument(projectId, documentId, user, dto),
    );
  }
}
