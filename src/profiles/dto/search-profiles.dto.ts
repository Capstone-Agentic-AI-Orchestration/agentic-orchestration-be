import { Transform, type TransformFnParams } from 'class-transformer';
import { IsArray, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { UserRole } from '@prisma/client';

export class SearchProfilesDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Transform(({ value }: TransformFnParams): unknown => {
    const rawValue = value as unknown;
    if (Array.isArray(rawValue)) return rawValue;
    if (typeof rawValue === 'string') {
      return rawValue
        .split(',')
        .map((role) => role.trim())
        .filter(Boolean);
    }
    return rawValue;
  })
  @IsArray()
  @IsEnum(UserRole, { each: true })
  roles?: UserRole[];

  @IsOptional()
  @Transform(({ value }: TransformFnParams): number => Number(value))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
