import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { Request } from 'express';
import type { RuntimeMachine } from '@prisma/client';
import { windowsInstallerScript } from './installer-script';
import { RuntimeCompanionService } from './runtime-companion.service';
import { RuntimeTokenGuard } from './runtime-token.guard';
import { CurrentMachine } from './current-machine.decorator';
import {
  CompleteRegistrationDto,
  CompleteTaskDto,
  HeartbeatDto,
  RegisterResourceDto,
  TaskHeartbeatDto,
} from './dto/runtime-companion.dto';
import { RuntimeTaskService, type ClaimedTaskPayload } from './runtime-task.service';

/**
 * The wire contract for the `devflow-runtime` companion daemon.
 *
 * The path is spelled out in full because `main.ts` sets no global prefix, and it is fixed by the
 * already-shipped client — this side has to match it exactly, not the other way round.
 *
 * `ValidationPipe` is applied per-method rather than on the class on purpose: `token/rotate` and
 * `claim` are bodyless POSTs sent with no `Content-Type`, and a class-level strict pipe rejects
 * them with a 400 that would be very hard to explain from the daemon's side.
 */
@Controller('api/v2/runtime-companion')
export class RuntimeCompanionController {
  constructor(
    private readonly companion: RuntimeCompanionService,
    private readonly tasks: RuntimeTaskService,
  ) {}

  /**
   * Tell a companion which web origins may reach its loopback API.
   *
   * Unauthenticated and carries no secrets — just the console's own public origins, which any
   * visitor already knows. It exists so a user never has to look up their deployed frontend domain
   * to configure the daemon; the daemon asks the server it was pointed at.
   */
  @Get('discovery')
  discovery() {
    return { webOrigins: this.companion.webOrigins() };
  }

  /**
   * The companion setup script, as a download.
   *
   * Unauthenticated on purpose: it contains no secrets, only this API's own public address. Pairing
   * still requires a signed-in session, so an anonymous download grants nothing.
   *
   * The server URL is taken from the request rather than configuration so the copy the user receives
   * already points at whichever host they reached — the one detail they would otherwise have to know.
   */
  @Get('install.cmd')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="devflow-companion-setup.cmd"')
  @Header('Cache-Control', 'no-store')
  installerScript(@Req() request: Request): string {
    const forwardedProto = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim();
    const protocol = forwardedProto || request.protocol || 'http';
    const host = request.get('host') ?? 'localhost:4000';
    return windowsInstallerScript(`${protocol}://${host}`);
  }

  /**
   * Unauthenticated by design — this is where a machine gets its first credential.
   *
   * The pairing code is the only thing standing in for authentication here, which is why it is
   * short-lived, single-use, and consumed atomically.
   */
  @Post('registrations/complete')
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async completeRegistration(@Body() dto: CompleteRegistrationDto) {
    return this.companion.completeRegistration(dto);
  }

  /** Liveness plus adapter reconciliation. Called every 30s by a running daemon. */
  @Post('heartbeat')
  @UseGuards(RuntimeTokenGuard)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async heartbeat(
    @CurrentMachine() machine: RuntimeMachine,
    @Body() dto: HeartbeatDto,
  ) {
    return this.companion.heartbeat(machine, dto);
  }

  @Post('resources')
  @UseGuards(RuntimeTokenGuard)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async registerResource(
    @CurrentMachine() machine: RuntimeMachine,
    @Body() dto: RegisterResourceDto,
  ) {
    return this.companion.registerResource(machine, dto);
  }

  /** Bodyless POST — no validation pipe, and nothing read from the request but the token. */
  @Post('token/rotate')
  @UseGuards(RuntimeTokenGuard)
  async rotateToken(@CurrentMachine() machine: RuntimeMachine) {
    return this.companion.rotateToken(machine);
  }

  /**
   * Ask for work.
   *
   * Returns `null` with a 200 when idle rather than 204, because the body carries a task when there
   * is one and the client treats any falsy result as "nothing to do". A 404 here would turn the
   * five-second poll into a permanent stream of errors in the user's terminal.
   */
  @Post('adapters/:adapterId/claim')
  @UseGuards(RuntimeTokenGuard)
  async claim(
    @CurrentMachine() machine: RuntimeMachine,
    @Param('adapterId') adapterId: string,
  ): Promise<ClaimedTaskPayload | null> {
    return this.tasks.claimForAdapter(machine, adapterId);
  }

  /**
   * Keep a lease alive, and learn whether to stop.
   *
   * The cancellation flag rides on this reply because it is the companion's only inbound channel
   * while a task is running.
   */
  @Post('tasks/:taskId/heartbeat')
  @UseGuards(RuntimeTokenGuard)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async taskHeartbeat(
    @CurrentMachine() machine: RuntimeMachine,
    @Param('taskId') taskId: string,
    @Body() dto: TaskHeartbeatDto,
  ) {
    return this.tasks.heartbeatTask(machine, taskId, dto.leaseToken);
  }

  /**
   * Report the outcome of a task.
   *
   * `whitelist` without `forbidNonWhitelisted`: the result object is free-form by contract, and
   * rejecting unknown keys would break clients that enrich it.
   */
  @Post('tasks/:taskId/complete')
  @UseGuards(RuntimeTokenGuard)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async completeTask(
    @CurrentMachine() machine: RuntimeMachine,
    @Param('taskId') taskId: string,
    @Body() dto: CompleteTaskDto,
  ) {
    return this.tasks.completeTask(machine, taskId, dto);
  }
}
