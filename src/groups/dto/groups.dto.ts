import { GroupRole } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateGroupDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  businessUnit?: string;
}

export class UpdateGroupDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  businessUnit?: string;
}

export class TransferGroupDto {
  @IsUUID()
  userId!: string;
}

export class CreateGroupInvitationDto {
  @IsUUID()
  userId!: string;

  @IsEnum(GroupRole)
  role!: GroupRole;
}

export class UpdateGroupMemberRoleDto {
  @IsEnum(GroupRole)
  role!: GroupRole;
}
