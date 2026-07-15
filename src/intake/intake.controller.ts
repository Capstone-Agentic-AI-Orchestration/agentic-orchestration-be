import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserRole } from '@prisma/client';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { executeIdempotentCommand } from '../shared/idempotency/idempotent-command';
import { IdempotencyService } from '../shared/idempotency/idempotency.service';
import {
  LockProjectIntakeDto,
  MarkIntakeReadyDto,
  RequestIntakeChangesDto,
  SaveProjectIntakeDraftDto,
  UploadIntakeDocumentDto,
} from './dto/intake.dto';
import { IntakeService } from './intake.service';

const uploadIntakeFileInterceptor = FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

interface UploadedIntakeFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Controller('projects/:projectId')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class IntakeController {
  constructor(
    private readonly intake: IntakeService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private runIdempotent<TBody>(
    idempotencyKey: string | undefined,
    scope: string,
    requestPayload: unknown,
    responseStatus: number,
    handler: () => Promise<TBody>,
  ): Promise<TBody> {
    return executeIdempotentCommand({ idempotency: this.idempotency, idempotencyKey, scope, requestPayload, responseStatus, handler });
  }

  @Get('intake')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.ADMIN)
  getIntake(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.intake.getIntake(projectId, user);
  }

  @Get('intake/template')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.ADMIN)
  async downloadTemplate(@Res() response: Response) {
    response.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="client-project-intake-template.md"');
    response.send(this.intake.templateMarkdown());
  }

  @Post('intake/draft')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  saveDraft(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: SaveProjectIntakeDraftDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(idempotencyKey, `user:${user.id}:POST:/projects/${projectId}/intake/draft`, dto, HttpStatus.OK, async () => {
      await this.intake.saveDraft(projectId, user, dto.payload);
      return this.intake.getIntake(projectId, user);
    });
  }

  @Post('intake/submit')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  submit(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.runIdempotent(idempotencyKey, `user:${user.id}:POST:/projects/${projectId}/intake/submit`, {}, HttpStatus.OK, async () => {
      await this.intake.submit(projectId, user);
      return this.intake.getIntake(projectId, user);
    });
  }

  @Post('intake/request-changes')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  requestChanges(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: RequestIntakeChangesDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(idempotencyKey, `user:${user.id}:POST:/projects/${projectId}/intake/request-changes`, dto, HttpStatus.OK, async () => {
      await this.intake.requestChanges(projectId, user, dto);
      return this.intake.getIntake(projectId, user);
    });
  }

  @Post('intake/ready')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  markReady(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: MarkIntakeReadyDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(idempotencyKey, `user:${user.id}:POST:/projects/${projectId}/intake/ready`, dto, HttpStatus.OK, async () => {
      await this.intake.markReady(projectId, user, dto.note);
      return this.intake.getIntake(projectId, user);
    });
  }

  @Post('intake/lock')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  lock(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: LockProjectIntakeDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(idempotencyKey, `user:${user.id}:POST:/projects/${projectId}/intake/lock`, dto, HttpStatus.OK, async () => {
      await this.intake.lock(projectId, user, dto.pmNotes);
      return this.intake.getIntake(projectId, user);
    });
  }

  @Post('documents/upload')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.ADMIN)
  @UseInterceptors(uploadIntakeFileInterceptor)
  upload(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedIntakeFile,
    @Body() dto: UploadIntakeDocumentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/projects/${projectId}/documents/upload`,
      { dto, fileName: file?.originalname, mimeType: file?.mimetype, size: file?.size },
      HttpStatus.CREATED,
      () => this.intake.uploadDocument(projectId, user, file, dto),
    );
  }

  @Post('documents/:documentId/retry-extraction')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @HttpCode(HttpStatus.ACCEPTED)
  retryExtraction(
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(idempotencyKey, `user:${user.id}:POST:/projects/${projectId}/documents/${documentId}/retry-extraction`, { documentId }, HttpStatus.ACCEPTED, () => this.intake.retryExtraction(projectId, documentId, user));
  }

  @Get('documents/:documentId/download')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.ADMIN)
  async download(
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
    @CurrentUser() user: AuthUser,
    @Res() response: Response,
  ) {
    const document = await this.intake.downloadDocument(projectId, documentId, user);
    response.setHeader('Content-Type', document.contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${document.fileName.replace(/"/g, '')}"`);
    response.send(document.content);
  }
}
