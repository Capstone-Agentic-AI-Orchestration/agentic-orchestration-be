import { Controller, Get, Post, Patch, Delete, Body, Headers, Param, UseGuards, UsePipes, ValidationPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { RuntimesService } from './runtimes.service';
import { CreateRuntimeProviderDto, UpdateRuntimeProviderDto } from './dto/runtimes.dto';
import { executeIdempotentCommand } from '../shared/idempotency/idempotent-command';
import { IdempotencyService } from '../shared/idempotency/idempotency.service';

@Controller('admin/runtimes')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class RuntimesController {
  constructor(
    private readonly runtimesService: RuntimesService,
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

  @Get('providers')
  @Roles('ADMIN', 'PM', 'DEV')
  async listProviders(@CurrentUser() user: AuthUser) {
    return this.runtimesService.listProviders(user.id);
  }

  /**
   * A replay must not create a second provider.
   *
   * The credential is written to Supabase Vault as part of this command, so a double-submitted
   * form would otherwise leave an orphaned secret behind the duplicate row.
   */
  @Post('providers')
  @Roles('ADMIN', 'PM', 'DEV')
  async createProvider(
    @Body() dto: CreateRuntimeProviderDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/admin/runtimes/providers`,
      dto,
      HttpStatus.CREATED,
      () => this.runtimesService.createProvider(dto, user.id),
    );
  }

  @Patch('providers/:id')
  @Roles('ADMIN', 'PM', 'DEV')
  async updateProvider(
    @Param('id') id: string,
    @Body() dto: UpdateRuntimeProviderDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/admin/runtimes/providers/${id}`,
      dto,
      HttpStatus.OK,
      () => this.runtimesService.updateProvider(id, dto, user.id),
    );
  }

  @Delete('providers/:id')
  @Roles('ADMIN', 'PM', 'DEV')
  @HttpCode(204)
  async deleteProvider(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    await this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:DELETE:/admin/runtimes/providers/${id}`,
      {},
      HttpStatus.NO_CONTENT,
      () => this.runtimesService.deleteProvider(id, user.id),
    );
  }

  /**
   * Verifies a stored credential against the provider's API.
   *
   * Replay-protected because it spends a real upstream call: a retried click should return the
   * recorded verdict rather than bill the user's provider account again.
   */
  @Post('providers/:id/test')
  @Roles('ADMIN', 'PM', 'DEV')
  async testProvider(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/admin/runtimes/providers/${id}/test`,
      {},
      HttpStatus.OK,
      () => this.runtimesService.testProvider(id, user.id),
    );
  }
}
