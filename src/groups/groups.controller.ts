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
import {
  CreateGroupDto,
  CreateGroupInvitationDto,
  TransferGroupDto,
  UpdateGroupDto,
  UpdateGroupMemberRoleDto,
} from './dto/groups.dto';
import { GroupsService } from './groups.service';
import { IdempotencyService } from '../shared/idempotency/idempotency.service';
import { executeIdempotentCommand } from '../shared/idempotency/idempotent-command';

@Controller('groups')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(UserRole.PM, UserRole.DEV, UserRole.ADMIN)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
export class GroupsController {
  constructor(
    private readonly groups: GroupsService,
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
  create(@Body() dto: CreateGroupDto, @CurrentUser() user: AuthUser, @Headers('idempotency-key') key?: string) {
    return this.runIdempotent(key, `user:${user.id}:POST:/groups`, dto, HttpStatus.CREATED, () => this.groups.create(dto, user));
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.groups.list(user);
  }

  @Get('invitations/mine')
  myInvitations(@CurrentUser() user: AuthUser) {
    return this.groups.listMyInvitations(user);
  }

  @Post('invitations/:invitationId/accept')
  acceptInvitation(@Param('invitationId') invitationId: string, @CurrentUser() user: AuthUser, @Headers('idempotency-key') key?: string) {
    return this.runIdempotent(key, `user:${user.id}:POST:/groups/invitations/${invitationId}/accept`, {}, HttpStatus.CREATED, () => this.groups.respondToInvitation(invitationId, true, user));
  }

  @Post('invitations/:invitationId/decline')
  declineInvitation(@Param('invitationId') invitationId: string, @CurrentUser() user: AuthUser, @Headers('idempotency-key') key?: string) {
    return this.runIdempotent(key, `user:${user.id}:POST:/groups/invitations/${invitationId}/decline`, {}, HttpStatus.CREATED, () => this.groups.respondToInvitation(invitationId, false, user));
  }

  @Get(':groupId')
  get(@Param('groupId') groupId: string, @CurrentUser() user: AuthUser) {
    return this.groups.get(groupId, user);
  }

  @Patch(':groupId')
  update(@Param('groupId') groupId: string, @Body() dto: UpdateGroupDto, @CurrentUser() user: AuthUser, @Headers('idempotency-key') key?: string) {
    return this.runIdempotent(key, `user:${user.id}:PATCH:/groups/${groupId}`, dto, HttpStatus.OK, () => this.groups.update(groupId, dto, user));
  }

  @Post(':groupId/archive')
  archive(@Param('groupId') groupId: string, @CurrentUser() user: AuthUser, @Headers('idempotency-key') key?: string) {
    return this.runIdempotent(key, `user:${user.id}:POST:/groups/${groupId}/archive`, {}, HttpStatus.CREATED, () => this.groups.archive(groupId, user));
  }

  @Post(':groupId/reopen')
  reopen(@Param('groupId') groupId: string, @CurrentUser() user: AuthUser, @Headers('idempotency-key') key?: string) {
    return this.runIdempotent(key, `user:${user.id}:POST:/groups/${groupId}/reopen`, {}, HttpStatus.CREATED, () => this.groups.reopen(groupId, user));
  }

  @Delete(':groupId')
  delete(@Param('groupId') groupId: string, @CurrentUser() user: AuthUser, @Headers('idempotency-key') key?: string) {
    return this.runIdempotent(key, `user:${user.id}:DELETE:/groups/${groupId}`, {}, HttpStatus.OK, () => this.groups.delete(groupId, user));
  }

  @Post(':groupId/transfer')
  transfer(@Param('groupId') groupId: string, @Body() dto: TransferGroupDto, @CurrentUser() user: AuthUser, @Headers('idempotency-key') key?: string) {
    return this.runIdempotent(key, `user:${user.id}:POST:/groups/${groupId}/transfer`, dto, HttpStatus.CREATED, () => this.groups.transfer(groupId, dto, user));
  }

  @Get(':groupId/members')
  members(@Param('groupId') groupId: string, @CurrentUser() user: AuthUser) {
    return this.groups.listMembers(groupId, user);
  }

  @Get(':groupId/eligible-users')
  eligibleUsers(@Param('groupId') groupId: string, @CurrentUser() user: AuthUser) {
    return this.groups.eligibleUsers(groupId, user);
  }

  @Patch(':groupId/members/:userId')
  updateMemberRole(
    @Param('groupId') groupId: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateGroupMemberRoleDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.runIdempotent(key, `user:${user.id}:PATCH:/groups/${groupId}/members/${userId}`, dto, HttpStatus.OK, () => this.groups.updateMemberRole(groupId, userId, dto, user));
  }

  @Delete(':groupId/members/:userId')
  removeMember(@Param('groupId') groupId: string, @Param('userId') userId: string, @CurrentUser() user: AuthUser, @Headers('idempotency-key') key?: string) {
    return this.runIdempotent(key, `user:${user.id}:DELETE:/groups/${groupId}/members/${userId}`, {}, HttpStatus.OK, () => this.groups.removeMember(groupId, userId, user));
  }

  @Post(':groupId/invitations')
  invite(
    @Param('groupId') groupId: string,
    @Body() dto: CreateGroupInvitationDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.runIdempotent(key, `user:${user.id}:POST:/groups/${groupId}/invitations`, dto, HttpStatus.CREATED, () => this.groups.invite(groupId, dto, user));
  }

  @Get(':groupId/invitations')
  invitations(@Param('groupId') groupId: string, @CurrentUser() user: AuthUser) {
    return this.groups.listInvitations(groupId, user);
  }

  @Delete(':groupId/invitations/:invitationId')
  revokeInvitation(
    @Param('groupId') groupId: string,
    @Param('invitationId') invitationId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.runIdempotent(key, `user:${user.id}:DELETE:/groups/${groupId}/invitations/${invitationId}`, {}, HttpStatus.OK, () => this.groups.revokeInvitation(groupId, invitationId, user));
  }

  @Get(':groupId/activity')
  activity(@Param('groupId') groupId: string, @CurrentUser() user: AuthUser) {
    return this.groups.activityFeed(groupId, user);
  }
}
