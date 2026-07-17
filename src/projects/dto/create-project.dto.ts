import { IsBoolean, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class CreateProjectDto {
  @IsString()
  @MinLength(1, { message: 'companyName must not be empty' })
  companyName!: string;

  @IsString()
  @MinLength(10, { message: 'brief must be at least 10 characters' })
  brief!: string;

  @IsString()
  @MinLength(1, { message: 'stackKey must not be empty' })
  stackKey!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  groupId?: string;

  @ValidateIf((input: CreateProjectDto) => Boolean(input.groupId) || Boolean(input.repositoryName))
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  repositoryName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(350)
  repositoryDescription?: string;

  /** When true, also provision a mobile (Expo/React Native) repository. Default: backend + frontend only. */
  @IsOptional()
  @IsBoolean()
  includeMobile?: boolean;
}
