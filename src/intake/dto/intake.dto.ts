import { IsArray, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SaveProjectIntakeDraftDto {
  @IsObject()
  payload!: Record<string, unknown>;
}

export class RequestIntakeChangesDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  section!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  message!: string;
}

export class MarkIntakeReadyDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  note?: string;
}

export class LockProjectIntakeDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  pmNotes?: string;
}

export class UploadIntakeDocumentDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  kind?: string;

  @IsOptional()
  @IsString()
  clientVisible?: string;
}

export class IntakeTemplateDto {
  @IsOptional()
  @IsArray()
  sections?: string[];
}
