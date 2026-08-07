import { AgentAccessScope, WorkspaceAgentStatus } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateAgentDto {
  @IsString()
  @MinLength(1, { message: 'name must not be empty' })
  @MaxLength(120)
  name!: string;

  @IsString()
  @MaxLength(64)
  groupId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  avatarEmoji?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  instructions?: string;

  /**
   * Which deployed Eve runtime executes this agent. Capability is a closed set because tools are
   * executable code; the console offers what is deployed and nothing else.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  runtimeKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  /** Matches the reference console's 1–50 range; the gateway is the real upper bound. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  concurrency?: number;

  @IsOptional()
  @IsEnum(AgentAccessScope)
  accessScope?: AgentAccessScope;
}

export class UpdateAgentDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'name must not be empty' })
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  avatarEmoji?: string;

  /**
   * Empty string clears the override and returns the agent to its built-in prompt, which is a
   * different intent from "no change" — hence a nullable column rather than a sentinel.
   */
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  instructions?: string;

  /** Ignored for built-ins: the pipeline dispatches those by key. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  runtimeKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  concurrency?: number;

  @IsOptional()
  @IsEnum(AgentAccessScope)
  accessScope?: AgentAccessScope;

  @IsOptional()
  @IsEnum(WorkspaceAgentStatus)
  status?: WorkspaceAgentStatus;
}

export class CreateAgentSkillDto {
  @IsString()
  @MaxLength(64)
  groupId!: string;

  @IsString()
  @MinLength(1, { message: 'name must not be empty' })
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  /** Markdown. Appended verbatim to the system prompt of every agent it is attached to. */
  @IsString()
  @MinLength(1, { message: 'body must not be empty' })
  @MaxLength(40000)
  body!: string;
}

export class UpdateAgentSkillDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'name must not be empty' })
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'body must not be empty' })
  @MaxLength(40000)
  body?: string;
}
