import { ProjectStatus } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'companyName must not be empty' })
  companyName?: string;

  @IsOptional()
  @IsString()
  @MinLength(10, { message: 'brief must be at least 10 characters' })
  brief?: string;

  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'stackKey must not be empty' })
  stackKey?: string;

  @IsOptional()
  @IsString()
  repoUrl?: string;

  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}
