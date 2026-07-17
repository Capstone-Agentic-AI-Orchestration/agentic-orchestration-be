import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { RAG_SOURCE_TYPES } from '../rag.types';

export class RagSearchDto {
  @IsString()
  @MaxLength(8_000)
  query!: string;

  @IsOptional() @IsString() runId?: string;
  @IsOptional() @IsString() workOrderId?: string;
  @IsOptional() @IsString() workOrderExecutionId?: string;
  @IsOptional() @IsString() agentName?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsIn(RAG_SOURCE_TYPES, { each: true }) sourceTypes?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) tags?: string[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
  @IsOptional() @IsBoolean() useVector?: boolean;
  @IsOptional() @IsBoolean() useKeyword?: boolean;
}

export class RagContextPackDto {
  @IsOptional() @IsString() runId?: string;
  @IsOptional() @IsString() workOrderId?: string;
  @IsOptional() @IsString() workOrderExecutionId?: string;
  @IsString() agentName!: string;
  @IsString() @MaxLength(8_000) currentTask!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1_000) @Max(40_000) maxContextChars?: number;
}

export class RagReindexSourceDto {
  @IsIn(RAG_SOURCE_TYPES) sourceType!: string;
  @IsString() sourceId!: string;
}

export class RagChunkListDto {
  @IsOptional() @IsIn(RAG_SOURCE_TYPES) sourceType?: string;
  @IsOptional() @IsString() agentName?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
