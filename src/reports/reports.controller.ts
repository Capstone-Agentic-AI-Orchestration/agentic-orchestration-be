import { Controller, Get, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { ReportsService } from './reports.service';

@Controller('reports')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('pm-summary')
  @Roles(UserRole.PM, UserRole.ADMIN)
  pmSummary(@CurrentUser() user: AuthUser) {
    return this.reportsService.pmSummary(user);
  }
}
