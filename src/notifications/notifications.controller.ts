import {
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { NotificationsService } from './notifications.service';
import { executeIdempotentCommand } from '../shared/idempotency/idempotent-command';
import { IdempotencyService } from '../shared/idempotency/idempotency.service';
import { CursorPageInput } from '../shared/pagination/cursor-pagination';

@Controller('notifications')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private runIdempotent<TBody>(
    idempotencyKey: string | undefined,
    scope: string,
    requestPayload: unknown,
    handler: () => Promise<TBody>,
  ): Promise<TBody> {
    return executeIdempotentCommand({
      idempotency: this.idempotency,
      idempotencyKey,
      scope,
      requestPayload,
      responseStatus: HttpStatus.OK,
      handler,
    });
  }

  @Get()
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  list(@CurrentUser() user: AuthUser, @Query() page?: CursorPageInput) {
    return this.notificationsService.list(user, page);
  }

  @Patch('read-all')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  markAllRead(
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/notifications/read-all`,
      { userId: user.id },
      () => this.notificationsService.markAllRead(user),
    );
  }

  @Patch(':id/read')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  markRead(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/notifications/${id}/read`,
      { notificationId: id },
      () => this.notificationsService.markRead(id, user),
    );
  }
}
