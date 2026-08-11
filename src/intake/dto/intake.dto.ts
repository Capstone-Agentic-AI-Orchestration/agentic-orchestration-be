import { IsArray, IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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

export class IntakeInterviewTurnDto {
  /** What the client just said. Omitted on the opening turn. */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  reply?: string;

  /**
   * Which topic the reply answers.
   *
   * Sent by the client rather than inferred from server state: a reply that arrives after the
   * agenda has moved on must be absorbed into the topic it was actually answering, not whatever is
   * current now.
   */
  @IsOptional()
  @IsIn(['goal', 'users', 'musthaves', 'boundaries'])
  topicId?: 'goal' | 'users' | 'musthaves' | 'boundaries';
}
