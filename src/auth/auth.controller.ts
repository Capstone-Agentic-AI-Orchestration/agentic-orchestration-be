import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from './current-user.decorator';
import { AuthUser } from './auth.types';
import { SupabaseAuthGuard } from './supabase-auth.guard';

@Controller('auth')
@UseGuards(SupabaseAuthGuard)
export class AuthController {
  @Get('me')
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }
}
