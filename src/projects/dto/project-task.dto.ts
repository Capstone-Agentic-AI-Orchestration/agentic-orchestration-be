import { ProjectTaskStatus } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Min, MinLength } from 'class-validator';

export class CreateProjectTaskDto {
  @IsString()
  @MinLength(1, { message: 'title must not be empty' })
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(ProjectTaskStatus)
  status?: ProjectTaskStatus;

  @IsOptional()
  @IsUUID()
  assignedToId?: string;

  @IsOptional()
  @IsString()
  artifactId?: string;
}

export class UpdateProjectTaskDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'title must not be empty' })
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(ProjectTaskStatus)
  status?: ProjectTaskStatus;

  @IsOptional()
  @IsUUID()
  assignedToId?: string;

  @IsOptional()
  @IsString()
  artifactId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}
