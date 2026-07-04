import { DeveloperAvailabilityStatus } from '@prisma/client';
import { IsArray, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class UpdateDeveloperCapacityDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skills?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(80)
  weeklyCapacityHours?: number;

  @IsOptional()
  @IsEnum(DeveloperAvailabilityStatus)
  availabilityStatus?: DeveloperAvailabilityStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
