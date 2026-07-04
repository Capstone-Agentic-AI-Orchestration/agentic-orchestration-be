import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateProjectKickoffDto {
  @IsOptional()
  @IsString()
  scopeSummary?: string;

  @IsOptional()
  @IsString()
  milestones?: string;

  @IsOptional()
  @IsString()
  requiredDocuments?: string;

  @IsOptional()
  @IsString()
  techStackNotes?: string;

  @IsOptional()
  @IsString()
  deliveryRoles?: string;

  @IsOptional()
  @IsString()
  readinessNotes?: string;

  @IsOptional()
  @IsBoolean()
  scopeConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  milestonesConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  documentsConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  techStackConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  rolesConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  clientAccessConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  initialTasksCreated?: boolean;

  @IsOptional()
  @IsBoolean()
  initialWorkOrdersCreated?: boolean;
}
