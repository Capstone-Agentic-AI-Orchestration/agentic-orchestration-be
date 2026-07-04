import { UserRole } from '@prisma/client';
import { IsEmail, IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';

export class AddProjectMemberDto {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsEnum(UserRole)
  role!: UserRole;
}

export class UpdateProjectMemberDto {
  @IsString()
  @IsUUID()
  userId!: string;

  @IsEnum(UserRole)
  role!: UserRole;
}
