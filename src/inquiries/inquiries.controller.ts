import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { InquiryStatus, UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CreateInquiryDto } from './dto/create-inquiry.dto';
import { ReviewInquiryDto } from './dto/review-inquiry.dto';
import { InquiriesService } from './inquiries.service';
import { ClientsService } from '../clients/clients.service';
import { executeIdempotentCommand } from '../shared/idempotency/idempotent-command';
import { IdempotencyService } from '../shared/idempotency/idempotency.service';
import { CursorPageInput } from '../shared/pagination/cursor-pagination';

@Controller('inquiries')
export class InquiriesController {
  constructor(
    private readonly inquiriesService: InquiriesService,
    private readonly idempotency: IdempotencyService,
    private readonly clients: ClientsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async create(
    @Body() dto: CreateInquiryDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return executeIdempotentCommand({
      idempotency: this.idempotency,
      idempotencyKey,
      scope: 'public:POST:/inquiries',
      requestPayload: dto,
      responseStatus: HttpStatus.CREATED,
      handler: () => this.inquiriesService.create(dto),
    });
  }

  @Get()
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  findAll(
    @Query('status') status?: InquiryStatus,
    @Query() page?: CursorPageInput,
  ) {
    return this.inquiriesService.findAll(status, page);
  }

  @Get(':id')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  findOne(@Param('id') id: string) {
    return this.inquiriesService.findOne(id);
  }

  /**
   * Existing clients this lead might already belong to, so approving a repeat customer files
   * their new project under the client they already have rather than creating a duplicate.
   */
  @Get(':id/client-suggestions')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  async findClientSuggestions(@Param('id') id: string) {
    const inquiry = await this.inquiriesService.findOne(id);
    return this.clients.suggestForInquiry({
      companyName: inquiry.companyName,
      email: inquiry.email,
    });
  }

  @Post(':id/approve')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  approve(
    @Param('id') id: string,
    @Body() dto: ReviewInquiryDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return executeIdempotentCommand({
      idempotency: this.idempotency,
      idempotencyKey,
      scope: `user:${user.id}:POST:/inquiries/${id}/approve`,
      requestPayload: dto,
      responseStatus: HttpStatus.OK,
      handler: () => this.inquiriesService.approve(id, user, dto),
    });
  }

  @Post(':id/reject')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  reject(
    @Param('id') id: string,
    @Body() dto: ReviewInquiryDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return executeIdempotentCommand({
      idempotency: this.idempotency,
      idempotencyKey,
      scope: `user:${user.id}:POST:/inquiries/${id}/reject`,
      requestPayload: dto,
      responseStatus: HttpStatus.OK,
      handler: () => this.inquiriesService.reject(id, user, dto),
    });
  }
}
