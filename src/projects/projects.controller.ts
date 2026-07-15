import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { UserRole } from '@prisma/client';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { ApproveGateDto } from './dto/approve-gate.dto';
import { ControlOrchestrationDto } from './dto/control-orchestration.dto';
import { AddProjectMemberDto } from './dto/project-member.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ShareArtifactDto } from './dto/share-artifact.dto';
import { ReviewArtifactDto } from './dto/review-artifact.dto';
import { HandleRevisionDto } from './dto/handle-revision.dto';
import { ProjectDeliveryReviewNoteDto } from './dto/project-delivery-review.dto';
import { PublishArtifactOutputDto, ReviewArtifactOutputDto } from './dto/output-review.dto';
import { CreateProjectTaskDto, UpdateProjectTaskDto } from './dto/project-task.dto';
import { AddTaskCommentDto } from './dto/task-comment.dto';
import { CreateWorkOrderDto, UpdateWorkOrderDto } from './dto/work-order.dto';
import { UpdateProjectKickoffDto } from './dto/project-kickoff.dto';
import { AutoAnalyzeBriefDto } from './dto/auto-analyze-brief.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { executeIdempotentCommand } from '../shared/idempotency/idempotent-command';
import { IdempotencyService } from '../shared/idempotency/idempotency.service';
import { CursorPageInput } from '../shared/pagination/cursor-pagination';

@Controller('projects')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
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

  @Post()
  @Roles(UserRole.PM, UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  create(
    @Body() dto: CreateProjectDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/projects`,
      dto,
      HttpStatus.CREATED,
      () => this.projectsService.create(dto, user),
    );
  }

  @Get()
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  findAll(@CurrentUser() user: AuthUser, @Query() page?: CursorPageInput) {
    return this.projectsService.findAll(user, page);
  }

  @Post('auto-analyze')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  autoAnalyzeBrief(
    @Body() dto: AutoAnalyzeBriefDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/projects/auto-analyze`,
      dto,
      HttpStatus.OK,
      () => this.projectsService.autoAnalyzeBrief(user, dto),
    );
  }

  @Get('details')
  @Roles(UserRole.ADMIN)
  findAllDetails(@CurrentUser() user: AuthUser) {
    return this.projectsService.findAllDetails(user);
  }

  @Get(':id')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.projectsService.findOne(id, user);
  }

  @Patch(':id')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProjectDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/projects/${id}`,
      dto,
      HttpStatus.OK,
      () => this.projectsService.update(id, user, dto),
    );
  }

  @Post(':id/members')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  addMember(
    @Param('id') id: string,
    @Body() dto: AddProjectMemberDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/projects/${id}/members`,
      dto,
      HttpStatus.CREATED,
      () => this.projectsService.addMember(id, user, dto),
    );
  }

  @Delete(':id/members/:userId')
  @Roles(UserRole.PM, UserRole.ADMIN)
  removeMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:DELETE:/projects/${id}/members/${userId}`,
      { userId },
      HttpStatus.OK,
      () => this.projectsService.removeMember(id, userId, user),
    );
  }

  @Get(':id/artifacts')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  findArtifacts(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Query() page?: CursorPageInput,
  ) {
    return this.projectsService.findArtifacts(id, user, page);
  }

  @Get(':id/artifacts/:artifactId')
  @Roles(UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  findArtifact(
    @Param('id') id: string,
    @Param('artifactId') artifactId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projectsService.findArtifact(id, artifactId, user);
  }

  @Get(':id/artifacts/:artifactId/download')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  async downloadArtifact(
    @Param('id') id: string,
    @Param('artifactId') artifactId: string,
    @CurrentUser() user: AuthUser,
    @Res() response: Response,
  ) {
    const artifact = await this.projectsService.downloadArtifact(id, artifactId, user);
    response.setHeader('Content-Type', artifact.contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${artifact.fileName}"`);
    response.send(artifact.content);
  }

  @Patch(':id/artifacts/:artifactId/share')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  shareArtifact(
    @Param('id') id: string,
    @Param('artifactId') artifactId: string,
    @Body() dto: ShareArtifactDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/projects/${id}/artifacts/${artifactId}/share`,
      dto,
      HttpStatus.OK,
      () => this.projectsService.updateArtifactSharing(id, artifactId, user, dto),
    );
  }

  @Post(':id/artifacts/:artifactId/review')
  @Roles(UserRole.CLIENT)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  reviewArtifact(
    @Param('id') id: string,
    @Param('artifactId') artifactId: string,
    @Body() dto: ReviewArtifactDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/projects/${id}/artifacts/${artifactId}/review`,
      dto,
      HttpStatus.OK,
      () => this.projectsService.reviewArtifact(id, artifactId, user, dto),
    );
  }

  @Patch(':id/artifacts/:artifactId/revision')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  handleRevision(
    @Param('id') id: string,
    @Param('artifactId') artifactId: string,
    @Body() dto: HandleRevisionDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/projects/${id}/artifacts/${artifactId}/revision`,
      dto,
      HttpStatus.OK,
      () => this.projectsService.handleRevision(id, artifactId, user, dto),
    );
  }

  @Patch(':id/artifacts/:artifactId/output-review')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  reviewArtifactOutput(
    @Param('id') id: string,
    @Param('artifactId') artifactId: string,
    @Body() dto: ReviewArtifactOutputDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/projects/${id}/artifacts/${artifactId}/output-review`,
      dto,
      HttpStatus.OK,
      () => this.projectsService.reviewArtifactOutput(id, artifactId, user, dto),
    );
  }

  @Post(':id/artifacts/:artifactId/publish')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  publishArtifactOutput(
    @Param('id') id: string,
    @Param('artifactId') artifactId: string,
    @Body() dto: PublishArtifactOutputDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/projects/${id}/artifacts/${artifactId}/publish`,
      dto,
      HttpStatus.OK,
      () => this.projectsService.publishArtifactOutput(id, artifactId, user, dto),
    );
  }

  @Get(':id/delivery-review')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  findDeliveryReview(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.projectsService.findDeliveryReview(id, user);
  }

  @Get(':id/delivery-readiness')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  findDeliveryReadiness(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.projectsService.findDeliveryReadiness(id, user);
  }

  @Post(':id/delivery-review/accept')
  @Roles(UserRole.CLIENT)
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  acceptDelivery(
    @Param('id') id: string,
    @Body() dto: ProjectDeliveryReviewNoteDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/projects/${id}/delivery-review/accept`,
      dto,
      HttpStatus.CREATED,
      () => this.projectsService.acceptDelivery(id, user, dto),
    );
  }

  @Post(':id/delivery-review/revision')
  @Roles(UserRole.CLIENT)
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  requestDeliveryRevision(
    @Param('id') id: string,
    @Body() dto: ProjectDeliveryReviewNoteDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/projects/${id}/delivery-review/revision`,
      dto,
      HttpStatus.CREATED,
      () => this.projectsService.requestDeliveryRevision(id, user, dto),
    );
  }

  @Patch(':id/delivery-review/resolve')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  resolveDeliveryRevision(
    @Param('id') id: string,
    @Body() dto: ProjectDeliveryReviewNoteDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/projects/${id}/delivery-review/resolve`,
      dto,
      HttpStatus.OK,
      () => this.projectsService.resolveDeliveryRevision(id, user, dto),
    );
  }

  @Get(':id/tasks')
  @Roles(UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  findTasks(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Query() page?: CursorPageInput,
  ) {
    return this.projectsService.findTasks(id, user, page);
  }

  @Get(':id/kickoff')
  @Roles(UserRole.PM, UserRole.ADMIN)
  findKickoff(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.projectsService.findKickoff(id, user);
  }

  @Patch(':id/kickoff')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  updateKickoff(
    @Param('id') id: string,
    @Body() dto: UpdateProjectKickoffDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/projects/${id}/kickoff`,
      dto,
      HttpStatus.OK,
      () => this.projectsService.updateKickoff(id, user, dto),
    );
  }

  @Post(':id/kickoff/tasks')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  createKickoffTasks(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/projects/${id}/kickoff/tasks`,
      {},
      HttpStatus.CREATED,
      () => this.projectsService.createKickoffTasks(id, user),
    );
  }

  @Post(':id/kickoff/work-orders')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  createKickoffWorkOrders(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/projects/${id}/kickoff/work-orders`,
      {},
      HttpStatus.CREATED,
      () => this.projectsService.createKickoffWorkOrders(id, user),
    );
  }

  @Post(':id/tasks')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  createTask(
    @Param('id') id: string,
    @Body() dto: CreateProjectTaskDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/projects/${id}/tasks`,
      dto,
      HttpStatus.CREATED,
      () => this.projectsService.createTask(id, user, dto),
    );
  }

  @Patch(':id/tasks/:taskId')
  @Roles(UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  updateTask(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body() dto: UpdateProjectTaskDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/projects/${id}/tasks/${taskId}`,
      dto,
      HttpStatus.OK,
      () => this.projectsService.updateTask(id, taskId, user, dto),
    );
  }

  @Get(':id/tasks/:taskId/activity')
  @Roles(UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  findTaskActivity(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @CurrentUser() user: AuthUser,
    @Query() page?: CursorPageInput,
  ) {
    return this.projectsService.findTaskActivity(id, taskId, user, page);
  }

  @Post(':id/tasks/:taskId/comments')
  @Roles(UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  addTaskComment(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body() dto: AddTaskCommentDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/projects/${id}/tasks/${taskId}/comments`,
      dto,
      HttpStatus.CREATED,
      () => this.projectsService.addTaskComment(id, taskId, user, dto),
    );
  }

  @Get(':id/work-orders')
  @Roles(UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  findWorkOrders(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Query() page?: CursorPageInput,
  ) {
    return this.projectsService.findWorkOrders(id, user, page);
  }

  @Post(':id/work-orders')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  createWorkOrder(
    @Param('id') id: string,
    @Body() dto: CreateWorkOrderDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/projects/${id}/work-orders`,
      dto,
      HttpStatus.CREATED,
      () => this.projectsService.createWorkOrder(id, user, dto),
    );
  }

  @Patch(':id/work-orders/:workOrderId')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  updateWorkOrder(
    @Param('id') id: string,
    @Param('workOrderId') workOrderId: string,
    @Body() dto: UpdateWorkOrderDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:PATCH:/projects/${id}/work-orders/${workOrderId}`,
      dto,
      HttpStatus.OK,
      () => this.projectsService.updateWorkOrder(id, workOrderId, user, dto),
    );
  }

  @Post(':id/work-orders/:workOrderId/dispatch')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @HttpCode(HttpStatus.ACCEPTED)
  dispatchWorkOrder(
    @Param('id') id: string,
    @Param('workOrderId') workOrderId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/projects/${id}/work-orders/${workOrderId}/dispatch`,
      {},
      HttpStatus.ACCEPTED,
      () => this.projectsService.dispatchWorkOrder(id, workOrderId, user),
    );
  }

  @Post(':id/work-orders/:workOrderId/retry')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @HttpCode(HttpStatus.ACCEPTED)
  retryWorkOrder(
    @Param('id') id: string,
    @Param('workOrderId') workOrderId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/projects/${id}/work-orders/${workOrderId}/retry`,
      {},
      HttpStatus.ACCEPTED,
      () => this.projectsService.retryFailedWorkOrder(id, workOrderId, user),
    );
  }

  @Get(':id/events')
  @Roles(UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  findEvents(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Query() page?: CursorPageInput,
  ) {
    return this.projectsService.findEvents(id, user, page);
  }

  @Get(':id/timeline')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  findTimeline(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Query() page?: CursorPageInput,
  ) {
    return this.projectsService.findTimeline(id, user, page);
  }

  @Post(':id/orchestration/start')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @HttpCode(HttpStatus.ACCEPTED)
  startOrchestration(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.projectsService.startOrchestration(id, user);
  }

  @Get(':id/orchestration/status')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  getOrchestrationStatus(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.projectsService.getStatus(id, user);
  }

  @Get(':id/orchestration/runs')
  @Roles(UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  findOrchestrationRuns(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.projectsService.findOrchestrationRuns(id, user);
  }

  @Get(':id/orchestration/runs/:runId')
  @Roles(UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  findOrchestrationRun(
    @Param('id') id: string,
    @Param('runId') runId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projectsService.findOrchestrationRun(id, runId, user);
  }

  @Get(':id/orchestration/provider')
  @Roles(UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  findOrchestrationProviderStatus(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.projectsService.findOrchestrationProviderStatus(id, user);
  }

  @Post(':id/orchestration/github-delivery/verify')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  verifyOrchestrationGithubDelivery(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.projectsService.verifyOrchestrationGithubDelivery(id, user);
  }

  @Post(':id/orchestration/llm-provider/verify')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  verifyOrchestrationLlmProvider(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.projectsService.verifyOrchestrationLlmProvider(id, user);
  }

  @Post(':id/orchestration/rerun-ready')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @HttpCode(HttpStatus.ACCEPTED)
  rerunReadyWorkOrders(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.projectsService.rerunReadyWorkOrders(id, user);
  }

  @Post(':id/orchestration/control')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  controlOrchestration(
    @Param('id') id: string,
    @Body() dto: ControlOrchestrationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projectsService.controlOrchestration(id, user, dto);
  }

  @Post(':id/gates/architecture')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  approveGate1(
    @Param('id') id: string,
    @Body() dto: ApproveGateDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/projects/${id}/gates/architecture`,
      dto,
      HttpStatus.OK,
      () => dto.acceptOpenQuestions === undefined
        ? this.projectsService.approveGate1(id, user, dto.approved, dto.notes)
        : this.projectsService.approveGate1(id, user, dto.approved, dto.notes, dto.acceptOpenQuestions),
    );
  }

  @Post(':id/gates/code')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  approveGate2(
    @Param('id') id: string,
    @Body() dto: ApproveGateDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runIdempotent(
      idempotencyKey,
      `user:${user.id}:POST:/projects/${id}/gates/code`,
      dto,
      HttpStatus.OK,
      () => this.projectsService.approveGate2(id, user, dto.approved, dto.notes),
    );
  }

  @Get(':id/status')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  getStatus(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.projectsService.getStatus(id, user);
  }
}
