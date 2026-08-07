import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, UsePipes, ValidationPipe, HttpCode } from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { RuntimesService } from './runtimes.service';
import { CreateRuntimeProviderDto, UpdateRuntimeProviderDto } from './dto/runtimes.dto';

@Controller('admin/runtimes')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class RuntimesController {
  constructor(private readonly runtimesService: RuntimesService) {}

  @Get('providers')
  @Roles('ADMIN', 'PM', 'DEV')
  async listProviders(@CurrentUser() user: AuthUser) {
    return this.runtimesService.listProviders(user.id);
  }

  @Post('providers')
  @Roles('ADMIN', 'PM', 'DEV')
  async createProvider(
    @Body() dto: CreateRuntimeProviderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.runtimesService.createProvider(dto, user.id);
  }

  @Patch('providers/:id')
  @Roles('ADMIN', 'PM', 'DEV')
  async updateProvider(
    @Param('id') id: string,
    @Body() dto: UpdateRuntimeProviderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.runtimesService.updateProvider(id, dto, user.id);
  }

  @Delete('providers/:id')
  @Roles('ADMIN', 'PM', 'DEV')
  @HttpCode(204)
  async deleteProvider(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.runtimesService.deleteProvider(id, user.id);
  }

  @Post('providers/:id/test')
  @Roles('ADMIN', 'PM', 'DEV')
  async testProvider(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.runtimesService.testProvider(id, user.id);
  }
}
