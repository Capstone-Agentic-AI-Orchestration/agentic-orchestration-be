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
import { AgentsService, type AgentListScope } from './agents.service';
import {
  CreateAgentDto,
  CreateAgentSkillDto,
  UpdateAgentDto,
  UpdateAgentSkillDto,
} from './dto/agent.dto';
import { executeIdempotentCommand } from '../shared/idempotency/idempotent-command';
import { IdempotencyService } from '../shared/idempotency/idempotency.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';

const SCOPES: AgentListScope[] = ['mine', 'all', 'archived'];

/**
 * Agent configuration is a staff surface. PM and DEV both reach it: the PM decides which
 * specialists a workspace keeps and how they are briefed, the developer tunes the ones that
 * write code. Clients never see it.
 *
 * The role guard decides who may use this feature; it does NOT decide which workspace. groupId
 * arrives from the query string or the body, so every service method asserts the caller is an
 * active member of the workspace it names. Without that, any authenticated PM or DEV could
 * rewrite another team's agent prompts — which the orchestration then runs — by changing one
 * query parameter.
 */
@Controller('agents')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(UserRole.PM, UserRole.DEV, UserRole.ADMIN)
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
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
  list(
    @CurrentUser() user: AuthUser,
    @Query('groupId') groupId: string,
    @Query('scope') scope?: string,
    @Query('search') search?: string,
  ) {
    const resolved = SCOPES.includes(scope as AgentListScope) ? (scope as AgentListScope) : 'all';
    return this.agents.list(user, groupId, resolved, search);
  }

  /** Capability profiles a custom agent can borrow. Not workspace data — no groupId needed. */
  @Get('runtimes')
  listRuntimes() {
    return this.agents.listRuntimes();
  }

  @Get('skills')
  listSkills(
    @CurrentUser() user: AuthUser,
    @Query('groupId') groupId: string,
    @Query('search') search?: string,
  ) {
    return this.agents.listSkills(user, groupId, search);
  }

  @Post('skills')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  createSkill(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateAgentSkillDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/agents/skills`,
      dto,
      HttpStatus.CREATED,
      () => this.agents.createSkill(user, dto),
    );
  }

  @Patch('skills/:skillId')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  updateSkill(
    @CurrentUser() user: AuthUser,
    @Param('skillId') skillId: string,
    @Body() dto: UpdateAgentSkillDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/agents/skills/${skillId}`,
      dto,
      HttpStatus.OK,
      () => this.agents.updateSkill(user, skillId, dto),
    );
  }

  @Delete('skills/:skillId')
  removeSkill(
    @CurrentUser() user: AuthUser,
    @Param('skillId') skillId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:DELETE:/agents/skills/${skillId}`,
      {},
      HttpStatus.OK,
      () => this.agents.removeSkill(user, skillId),
    );
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.agents.findOne(user, id);
  }

  @Post()
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateAgentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/agents`,
      dto,
      HttpStatus.CREATED,
      () => this.agents.create(user, dto),
    );
  }

  @Patch(':id')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateAgentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/agents/${id}`,
      dto,
      HttpStatus.OK,
      () => this.agents.update(user, id, dto),
    );
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:DELETE:/agents/${id}`,
      {},
      HttpStatus.OK,
      () => this.agents.remove(user, id),
    );
  }

  @Post(':id/skills/:skillId')
  attachSkill(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('skillId') skillId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/agents/${id}/skills/${skillId}`,
      {},
      HttpStatus.OK,
      () => this.agents.attachSkill(user, id, skillId),
    );
  }

  @Delete(':id/skills/:skillId')
  detachSkill(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('skillId') skillId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:DELETE:/agents/${id}/skills/${skillId}`,
      {},
      HttpStatus.OK,
      () => this.agents.detachSkill(user, id, skillId),
    );
  }
}
