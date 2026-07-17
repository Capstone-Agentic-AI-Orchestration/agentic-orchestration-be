import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { SupabaseAuthGuard } from './supabase-auth.guard';
import { SupabaseAuthService } from './supabase-auth.service';
import { RolesGuard } from './roles.guard';
import { GithubTeamsModule } from '../github/github-teams.module';

@Module({
  imports: [PrismaModule, GithubTeamsModule],
  controllers: [AuthController],
  providers: [SupabaseAuthGuard, SupabaseAuthService, RolesGuard],
  exports: [SupabaseAuthGuard, SupabaseAuthService, RolesGuard],
})
export class AuthModule {}
