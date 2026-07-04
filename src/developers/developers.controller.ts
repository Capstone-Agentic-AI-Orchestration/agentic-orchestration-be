import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Patch,
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
import { UpdateDeveloperCapacityDto } from './dto/developer.dto';
import { DevelopersService } from './developers.service';

@Controller('developers')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class DevelopersController {
  constructor(
    private readonly developersService: DevelopersService,
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
  @Roles(UserRole.PM, UserRole.ADMIN)
  list(@Query() page?: CursorPageInput) {
    return this.developersService.list(page);
  }

  @Get(':id')
  @Roles(UserRole.PM, UserRole.ADMIN, UserRole.DEV)
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.developersService.get(id, user);
  }

  @Patch('me/capacity')
  @Roles(UserRole.DEV)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  updateMe(
    @Body() dto: UpdateDeveloperCapacityDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/developers/me/capacity`,
      dto,
      HttpStatus.OK,
      () => this.developersService.updateMe(user, dto),
    );
  }
}
