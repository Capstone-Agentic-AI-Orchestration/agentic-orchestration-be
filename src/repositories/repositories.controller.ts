import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpStatus,
  Param,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CreateRepositoryAssignmentDto, CreateRepositoryDto } from './dto/repositories.dto';
import { RepositoriesService } from './repositories.service';
import { IdempotencyService } from '../shared/idempotency/idempotency.service';
import { executeIdempotentCommand } from '../shared/idempotency/idempotent-command';

/**
 * Provisioning a project repository is the PM's job: it decides where a client's code
 * lives and who may push to it, which is an engagement decision rather than a build step.
 *
 * The class-level @Roles is the READ baseline — developers need to see the repositories
 * they work in. Every mutating route re-declares @Roles(PM, ADMIN) to override it, because
 * RolesGuard resolves with getAllAndOverride: the handler decorator wins when present, and
 * the class decorator applies only where a handler declares none.
 */
@Controller('repositories')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(UserRole.PM, UserRole.DEV, UserRole.ADMIN)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
export class RepositoriesController {
  constructor(
    private readonly repositories: RepositoriesService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private runIdempotent<T>(
    key: string | undefined,
    scope: string,
    payload: unknown,
    status: number,
    handler: () => Promise<T>,
  ) {
    return executeIdempotentCommand({
      idempotency: this.idempotency,
      idempotencyKey: key,
      scope,
      requestPayload: payload,
      responseStatus: status,
      handler,
    });
  }

  @Post()
  @Roles(UserRole.PM, UserRole.ADMIN)
  create(@Body() dto: CreateRepositoryDto, @CurrentUser() user: AuthUser, @Headers('idempotency-key') key?: string) {
    return this.runIdempotent(key, `user:${user.id}:POST:/repositories`, dto, HttpStatus.CREATED, () => this.repositories.create(dto, user));
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.repositories.list(user);
  }

  @Get(':repositoryId')
  get(@Param('repositoryId') repositoryId: string, @CurrentUser() user: AuthUser) {
    return this.repositories.get(repositoryId, user);
  }

  @Post(':repositoryId/retry')
  @Roles(UserRole.PM, UserRole.ADMIN)
  retry(@Param('repositoryId') repositoryId: string, @CurrentUser() user: AuthUser, @Headers('idempotency-key') key?: string) {
    return this.runIdempotent(key, `user:${user.id}:POST:/repositories/${repositoryId}/retry`, {}, HttpStatus.CREATED, () => this.repositories.retryProvisioning(repositoryId, user));
  }

  @Post(':repositoryId/archive')
  @Roles(UserRole.PM, UserRole.ADMIN)
  archive(@Param('repositoryId') repositoryId: string, @CurrentUser() user: AuthUser, @Headers('idempotency-key') key?: string) {
    return this.runIdempotent(key, `user:${user.id}:POST:/repositories/${repositoryId}/archive`, {}, HttpStatus.CREATED, () => this.repositories.archive(repositoryId, user));
  }

  @Get(':repositoryId/assignments')
  assignments(@Param('repositoryId') repositoryId: string, @CurrentUser() user: AuthUser) {
    return this.repositories.listAssignments(repositoryId, user);
  }

  @Post(':repositoryId/assignments')
  @Roles(UserRole.PM, UserRole.ADMIN)
  assign(
    @Param('repositoryId') repositoryId: string,
    @Body() dto: CreateRepositoryAssignmentDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.runIdempotent(key, `user:${user.id}:POST:/repositories/${repositoryId}/assignments`, dto, HttpStatus.CREATED, () => this.repositories.assign(repositoryId, dto.userId, user));
  }

  @Delete(':repositoryId/assignments/:userId')
  @Roles(UserRole.PM, UserRole.ADMIN)
  revoke(
    @Param('repositoryId') repositoryId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.runIdempotent(key, `user:${user.id}:DELETE:/repositories/${repositoryId}/assignments/${userId}`, {}, HttpStatus.OK, () => this.repositories.revoke(repositoryId, userId, user));
  }

  @Post(':repositoryId/assignments/:userId/reconcile')
  @Roles(UserRole.PM, UserRole.ADMIN)
  reconcile(
    @Param('repositoryId') repositoryId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.runIdempotent(key, `user:${user.id}:POST:/repositories/${repositoryId}/assignments/${userId}/reconcile`, {}, HttpStatus.CREATED, () => this.repositories.reconcile(repositoryId, userId, user));
  }
}
