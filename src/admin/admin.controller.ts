import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
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
import {
  CreateAdminDomainDto,
  HandoffOverrideDto,
  LinkAdminRepositoryDto,
  UpdateAdminDomainDto,
  UpdateAdminUserRoleDto,
  UpdateAdminUserStatusDto,
  UpdatePlatformSettingDto,
} from './dto/admin.dto';
import { AdminService } from './admin.service';

@Controller('admin')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
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

  @Get('users')
  users(
    @Query('q') q?: string,
    @Query('role') role?: UserRole,
    @Query() page?: CursorPageInput,
  ) {
    return this.adminService.listUsers({ q, role, page });
  }

  @Patch('users/:id/role')
  updateUserRole(
    @Param('id') id: string,
    @Body() dto: UpdateAdminUserRoleDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/admin/users/${id}/role`,
      dto,
      HttpStatus.OK,
      () => this.adminService.updateUserRole(id, dto.role, user),
    );
  }

  @Patch('users/:id/status')
  updateUserStatus(
    @Param('id') id: string,
    @Body() dto: UpdateAdminUserStatusDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/admin/users/${id}/status`,
      dto,
      HttpStatus.OK,
      () => this.adminService.updateUserStatus(id, dto.status, user),
    );
  }

  @Get('domains')
  domains(@Query() page?: CursorPageInput) {
    return this.adminService.listDomains(page);
  }

  @Post('domains')
  createDomain(
    @Body() dto: CreateAdminDomainDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/admin/domains`,
      dto,
      HttpStatus.CREATED,
      () => this.adminService.createDomain(dto, user),
    );
  }

  @Patch('domains/:id')
  updateDomain(
    @Param('id') id: string,
    @Body() dto: UpdateAdminDomainDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/admin/domains/${id}`,
      dto,
      HttpStatus.OK,
      () => this.adminService.updateDomain(id, dto, user),
    );
  }

  @Post('domains/:id/verify')
  verifyDomain(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/admin/domains/${id}/verify`,
      { domainId: id },
      HttpStatus.CREATED,
      () => this.adminService.verifyDomain(id, user),
    );
  }

  @Delete('domains/:id')
  deleteDomain(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:DELETE:/admin/domains/${id}`,
      { domainId: id },
      HttpStatus.OK,
      () => this.adminService.deleteDomain(id, user),
    );
  }

  @Get('repositories')
  repositories(@Query() page?: CursorPageInput) {
    return this.adminService.listRepositories(page);
  }

  @Post('projects/:id/repository/create')
  createRepository(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/admin/projects/${id}/repository/create`,
      { projectId: id },
      HttpStatus.CREATED,
      () => this.adminService.createRepository(id, user),
    );
  }

  @Patch('projects/:id/repository')
  linkRepository(
    @Param('id') id: string,
    @Body() dto: LinkAdminRepositoryDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/admin/projects/${id}/repository`,
      dto,
      HttpStatus.OK,
      () => this.adminService.linkRepository(id, dto.repoUrl, user),
    );
  }

  @Get('handoffs')
  handoffs(@Query() page?: CursorPageInput) {
    return this.adminService.listHandoffs(page);
  }

  @Post('projects/:id/handoff/override')
  overrideHandoff(
    @Param('id') id: string,
    @Body() dto: HandoffOverrideDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/admin/projects/${id}/handoff/override`,
      dto,
      HttpStatus.CREATED,
      () => this.adminService.overrideHandoff(id, dto, user),
    );
  }

  @Get('usage')
  usage() {
    return this.adminService.usage();
  }

  @Get('health')
  health() {
    return this.adminService.health();
  }

  @Get('audit-logs')
  auditLogs(@Query('limit') limit?: string) {
    return this.adminService.auditLogs(limit ? Number(limit) : undefined);
  }

  @Get('settings')
  settings() {
    return this.adminService.settings();
  }

  @Patch('settings/:key')
  updateSetting(
    @Param('key') key: string,
    @Body() dto: UpdatePlatformSettingDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/admin/settings/${key}`,
      dto,
      HttpStatus.OK,
      () => this.adminService.updateSetting(key, dto.value, user),
    );
  }
}
