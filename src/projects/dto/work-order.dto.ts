import { WorkOrderAgentType, WorkOrderPriority, WorkOrderStatus } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreateWorkOrderDto {
  @IsString()
  @MinLength(1, { message: 'title must not be empty' })
  title!: string;

  @IsOptional()
  @IsString()
  instructions?: string;

  /** The OUTPUT contract: which extensions, language and signals the validator will require. */
  @IsEnum(WorkOrderAgentType)
  agentType!: WorkOrderAgentType;

  /**
   * The configured agent that should do the work.
   *
   * Optional: omitted, the role is derived from `agentType` exactly as before. Supplied, the
   * agent's own instructions and attached skills shape the prompt.
   */
  @IsOptional()
  @IsString()
  workspaceAgentId?: string;

  @IsOptional()
  @IsEnum(WorkOrderPriority)
  priority?: WorkOrderPriority;

  @IsOptional()
  @IsString()
  taskId?: string;

  @IsOptional()
  @IsString()
  artifactId?: string;
}

export class UpdateWorkOrderDto {
  /** Reassign the work order to a different configured agent, or clear it with an empty string. */
  @IsOptional()
  @IsString()
  workspaceAgentId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'title must not be empty' })
  title?: string;

  @IsOptional()
  @IsString()
  instructions?: string;

  @IsOptional()
  @IsEnum(WorkOrderAgentType)
  agentType?: WorkOrderAgentType;

  @IsOptional()
  @IsEnum(WorkOrderPriority)
  priority?: WorkOrderPriority;

  @IsOptional()
  @IsEnum(WorkOrderStatus)
  status?: WorkOrderStatus;

  @IsOptional()
  @IsString()
  taskId?: string;

  @IsOptional()
  @IsString()
  artifactId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}
