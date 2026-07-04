import { ScheduleEventType, ScheduleVisibility } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateScheduleEventDto {
  @IsString()
  @MaxLength(160)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsDateString()
  startsAt!: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @IsOptional()
  @IsEnum(ScheduleEventType)
  type?: ScheduleEventType;

  @IsOptional()
  @IsEnum(ScheduleVisibility)
  visibility?: ScheduleVisibility;

  @IsOptional()
  @IsString()
  projectId?: string;
}

export class UpdateScheduleEventDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @IsOptional()
  @IsEnum(ScheduleEventType)
  type?: ScheduleEventType;

  @IsOptional()
  @IsEnum(ScheduleVisibility)
  visibility?: ScheduleVisibility;

  @IsOptional()
  @IsString()
  projectId?: string;
}
