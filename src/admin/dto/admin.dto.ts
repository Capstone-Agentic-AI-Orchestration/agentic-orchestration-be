import { AdminDomainStatus, ProfileStatus, UserRole } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateAdminUserRoleDto {
  @IsEnum(UserRole)
  role!: UserRole;
}

export class UpdateAdminUserStatusDto {
  @IsEnum(ProfileStatus)
  status!: ProfileStatus;
}

export class CreateAdminDomainDto {
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  name!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  type!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  owner?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  target?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  environment?: string;
}

export class UpdateAdminDomainDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  owner?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  target?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  environment?: string;

  @IsOptional()
  @IsEnum(AdminDomainStatus)
  status?: AdminDomainStatus;
}

export class LinkAdminRepositoryDto {
  @IsUrl({ require_protocol: true })
  repoUrl!: string;
}

export class HandoffOverrideDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note!: string;

  @IsOptional()
  @IsBoolean()
  markReady?: boolean;
}

export class UpdatePlatformSettingDto {
  @IsObject()
  value!: Record<string, unknown>;
}
