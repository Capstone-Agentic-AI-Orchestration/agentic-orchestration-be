import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { RuntimeCompanionService } from './runtime-companion.service';
import { CreatePairingCodeDto } from './dto/runtime-companion.dto';
import { executeIdempotentCommand } from '../shared/idempotency/idempotent-command';
import { IdempotencyService } from '../shared/idempotency/idempotency.service';

/**
 * Browser-facing half of the companion feature: see your machines, pair a new one, revoke one.
 *
 * Everything here is scoped to the calling user rather than gated by role. A machine is somebody's
 * own workstation, so ownership is the meaningful boundary — an admin has no more business seeing
 * a developer's laptop than the other way round.
 */
@Controller('admin/runtimes/machines')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.PM, UserRole.DEV)
export class MachinesController {
  constructor(
    private readonly companion: RuntimeCompanionService,
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

  @Get()
  async listMachines(@CurrentUser() user: AuthUser) {
    return this.companion.listMachines(user.id);
  }

  /**
   * Mint a pairing code to carry to the terminal.
   *
   * The plaintext code is returned exactly once and only the hash is kept, so it cannot be shown
   * again later — generating a fresh one is the recovery path. That is also why a replayed request
   * must return the stored response rather than mint a second code: a double-submitted form would
   * otherwise silently invalidate the code the user is already reading off the screen.
   */
  @Post('pairing-codes')
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async createPairingCode(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreatePairingCodeDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/admin/runtimes/machines/pairing-codes`,
      dto,
      HttpStatus.CREATED,
      () => this.companion.createPairingCode(user.id, dto.groupId),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  async revokeMachine(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<void> {
    await this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:DELETE:/admin/runtimes/machines/${id}`,
      {},
      HttpStatus.NO_CONTENT,
      () => this.companion.revokeMachine(id, user.id),
    );
  }
}
