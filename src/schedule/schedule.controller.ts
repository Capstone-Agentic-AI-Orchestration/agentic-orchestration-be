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
import { CreateScheduleEventDto, UpdateScheduleEventDto } from './dto/schedule.dto';
import { ScheduleService } from './schedule.service';

@Controller('schedule/events')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class ScheduleController {
  constructor(
    private readonly scheduleService: ScheduleService,
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

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() page?: CursorPageInput) {
    return this.scheduleService.list(user, page);
  }

  @Post()
  create(
    @Body() dto: CreateScheduleEventDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/schedule/events`,
      dto,
      HttpStatus.CREATED,
      () => this.scheduleService.create(user, dto),
    );
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateScheduleEventDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/schedule/events/${id}`,
      dto,
      HttpStatus.OK,
      () => this.scheduleService.update(id, user, dto),
    );
  }

  @Delete(':id')
  delete(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:DELETE:/schedule/events/${id}`,
      { eventId: id },
      HttpStatus.OK,
      () => this.scheduleService.delete(id, user),
    );
  }
}
