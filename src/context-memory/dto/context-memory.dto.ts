import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CONTEXT_MEMORY_TYPES, ContextMemoryType } from '../context-memory.types';

export class ContextMemoryArtifactDto {
  @IsOptional()
  @IsString()
  path?: string;

  @IsOptional()
  @IsString()
  kind?: string;

  @IsOptional()
  @IsString()
  uri?: string;

  @IsOptional()
  @IsString()
  sha256?: string;
}

export class ContextMemoryProgressDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  node?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  percent?: number;
}

export class RecordContextMemoryDto {
  @IsString()
  projectId!: string;

  @IsOptional()
  @IsString()
  runId?: string;

  @IsOptional()
  @IsString()
  agentType?: string;

  @IsIn(CONTEXT_MEMORY_TYPES)
  type!: ContextMemoryType;

  @IsString()
  title!: string;

  @IsString()
  content!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  importance?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(25)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ContextMemoryArtifactDto)
  artifact?: ContextMemoryArtifactDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ContextMemoryProgressDto)
  progress?: ContextMemoryProgressDto;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class BuildContextPackDto {
  @IsString()
  projectId!: string;

  @IsOptional()
  @IsString()
  runId?: string;

  @IsString()
  agentType!: string;

  @IsString()
  task!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(25)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(80000)
  maxChars?: number;
}

export class SearchContextMemoryDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  runId?: string;

  @IsOptional()
  @IsString()
  agentType?: string;

  @IsOptional()
  @IsString()
  query?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(25)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsIn(CONTEXT_MEMORY_TYPES, { each: true })
  types?: ContextMemoryType[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
