import { Controller, Get, Headers, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { executeIdempotentCommand } from '../shared/idempotency/idempotent-command';
import { IdempotencyService } from '../shared/idempotency/idempotency.service';
import { CursorPageInput } from '../shared/pagination/cursor-pagination';
import { ClientInvitesService } from './client-invites.service';

@Controller('client-invites')
export class ClientInvitesController {
  constructor(
    private readonly clientInvitesService: ClientInvitesService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('status')
  status(@Query('email') email = '') {
    return this.clientInvitesService.publicStatus(email);
  }

  @Get('me')
  @Roles(UserRole.CLIENT)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  listMine(@CurrentUser() user: AuthUser, @Query() page?: CursorPageInput) {
    return this.clientInvitesService.listMine(user, page);
  }

  @Post('accept')
  @Roles(UserRole.CLIENT)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  acceptMine(
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return executeIdempotentCommand({
      idempotency: this.idempotency,
      idempotencyKey,
      scope: `user:${user.id}:POST:/client-invites/accept`,
      requestPayload: {
        userId: user.id,
        email: user.email,
      },
      responseStatus: HttpStatus.CREATED,
      handler: () => this.clientInvitesService.acceptMine(user),
    });
  }
}
