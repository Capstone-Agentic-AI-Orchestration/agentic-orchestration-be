import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
  constructor(private readonly companion: RuntimeCompanionService) {}

  @Get()
  async listMachines(@CurrentUser() user: AuthUser) {
    return this.companion.listMachines(user.id);
  }

  /**
   * Mint a pairing code to carry to the terminal.
   *
   * The plaintext code is returned exactly once and only the hash is kept, so it cannot be shown
   * again later — generating a fresh one is the recovery path.
   */
  @Post('pairing-codes')
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async createPairingCode(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreatePairingCodeDto,
  ) {
    return this.companion.createPairingCode(user.id, dto.groupId);
  }

  @Delete(':id')
  @HttpCode(204)
  async revokeMachine(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.companion.revokeMachine(id, user.id);
  }
}
