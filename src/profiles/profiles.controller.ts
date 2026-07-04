import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
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
import { SearchProfilesDto } from './dto/search-profiles.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfilesService } from './profiles.service';

@Controller('profiles')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class ProfilesController {
  constructor(
    private readonly profilesService: ProfilesService,
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

  @Get('me')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  me(@CurrentUser() user: AuthUser) {
    return this.profilesService.me(user);
  }

  @Patch('me')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  updateMe(
    @Body() dto: UpdateProfileDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/profiles/me`,
      dto,
      HttpStatus.OK,
      () => this.profilesService.updateMe(user, dto),
    );
  }

  @Get()
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  search(@Query() query: SearchProfilesDto) {
    return this.profilesService.search(query);
  }
}
