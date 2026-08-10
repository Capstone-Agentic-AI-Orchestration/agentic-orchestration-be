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
import { ClientsService } from './clients.service';
import { executeIdempotentCommand } from '../shared/idempotency/idempotent-command';
import { IdempotencyService } from '../shared/idempotency/idempotency.service';
import {
  AddClientContactDto,
  CreateClientDto,
  SetProjectClientDto,
  UpdateClientDto,
} from './dto/client.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';

/**
 * The client directory is a staff surface: it lists every company the agency works with, so it
 * is PM/ADMIN only. Clients reach their own data through the separate client application.
 *
 * One exception, `GET mine`, which answers "which company am I?" for the caller and is therefore
 * open to CLIENT as well. It returns only companies the caller is a contact of, so it exposes
 * nothing the directory itself would.
 */
@Controller('clients')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(UserRole.PM, UserRole.ADMIN)
export class ClientsController {
  constructor(
    private readonly clients: ClientsService,
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

  @Get()
  list(@Query('search') search?: string, @Query('groupId') groupId?: string) {
    return this.clients.list(search, groupId);
  }

  // GET unassigned-projects was here. Project.clientId is non-null, so it could only ever
  // return an empty list — a project without a client cannot be created or left behind.

  @Get('contact-candidates')
  searchContactCandidates(@Query('search') search?: string) {
    return this.clients.searchContactCandidates(search);
  }

  @Post()
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  create(
    @Body() dto: CreateClientDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/clients`,
      dto,
      HttpStatus.CREATED,
      () => this.clients.create(user, dto),
    );
  }

  /**
   * The companies the caller is a contact of. The one client-facing route on this controller.
   *
   * A client needs its own company id before it can open /clients/:clientId/conversations, and it
   * cannot get one from a project: a contact with no project at all is still someone the project
   * manager is talking to, which is the reason those threads moved off projects in the first place.
   *
   * Declared above `@Get(':id')` deliberately. Nest matches routes in declaration order within a
   * controller, so moving this below the wildcard would send every request for it into the staff-only
   * findOne and answer a client with 403.
   */
  @Get('mine')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.ADMIN)
  findMine(@CurrentUser() user: AuthUser) {
    return this.clients.listForContact(user);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.clients.findOne(id);
  }

  @Patch(':id')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  update(
    @Param('id') id: string,
    @Body() dto: UpdateClientDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/clients/${id}`,
      dto,
      HttpStatus.OK,
      () => this.clients.update(id, dto),
    );
  }

  @Get(':id/projects')
  findProjects(@Param('id') id: string) {
    return this.clients.findProjects(id);
  }

  @Get(':id/documents')
  findDocuments(@Param('id') id: string) {
    return this.clients.findDocuments(id);
  }

  @Get(':id/contacts')
  findContacts(@Param('id') id: string) {
    return this.clients.findContacts(id);
  }

  @Post(':id/contacts')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  addContact(
    @Param('id') id: string,
    @Body() dto: AddClientContactDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/clients/${id}/contacts`,
      dto,
      HttpStatus.CREATED,
      () => this.clients.addContact(id, dto),
    );
  }

  @Delete(':id/contacts/:contactId')
  removeContact(
    @Param('id') id: string,
    @Param('contactId') contactId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:DELETE:/clients/${id}/contacts/${contactId}`,
      { contactId },
      HttpStatus.OK,
      () => this.clients.removeContact(id, contactId),
    );
  }

  /**
   * Links a project to a client, or clears it with `{ "clientId": null }`.
   *
   * Lives here rather than on the projects controller because it is a directory operation: the
   * client owns the relationship, and the console reaches it from the client and unassigned views.
   */
  @Patch('projects/:projectId/client')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  setProjectClient(
    @Param('projectId') projectId: string,
    @Body() dto: SetProjectClientDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/clients/projects/${projectId}/client`,
      dto,
      HttpStatus.OK,
      () => this.clients.setProjectClient(projectId, dto.clientId ?? null),
    );
  }
}
