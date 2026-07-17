import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RepositoryKind } from '@prisma/client';

export class CreateRepositoryDto {
  @IsUUID()
  groupId!: string;

  @IsString()
  @MinLength(1)
  projectId!: string;

  @IsOptional()
  @IsEnum(RepositoryKind)
  kind?: RepositoryKind;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message: 'name may only contain letters, numbers, dots, underscores, and hyphens',
  })
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(350)
  description?: string;
}

export class CreateRepositoryAssignmentDto {
  @IsUUID()
  userId!: string;
}
