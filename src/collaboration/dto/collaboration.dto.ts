import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUrl, Min, MinLength } from 'class-validator';
import {
  CollaborationDocumentKind,
  CollaborationDocumentStatus,
  CollaborationVisibility,
  ConversationCategory,
} from '@prisma/client';

export class CreateConversationDto {
  @IsString()
  @MinLength(1, { message: 'title must not be empty' })
  title!: string;

  @IsOptional()
  @IsEnum(ConversationCategory)
  category?: ConversationCategory;

  @IsOptional()
  @IsEnum(CollaborationVisibility)
  visibility?: CollaborationVisibility;

  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'message must not be empty' })
  message?: string;
}

export class CreateMessageDto {
  @IsString()
  @MinLength(1, { message: 'body must not be empty' })
  body!: string;
}

export class CreateCollaborationDocumentDto {
  @IsString()
  @MinLength(1, { message: 'title must not be empty' })
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  fileName?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true }, { message: 'externalUrl must be an absolute URL' })
  externalUrl?: string;

  @IsOptional()
  @IsString()
  artifactId?: string;

  @IsOptional()
  @IsEnum(CollaborationDocumentKind)
  kind?: CollaborationDocumentKind;

  @IsOptional()
  @IsEnum(CollaborationDocumentStatus)
  status?: CollaborationDocumentStatus;

  @IsOptional()
  @IsBoolean()
  clientVisible?: boolean;
}

export class UpdateCollaborationDocumentDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'title must not be empty' })
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  fileName?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true }, { message: 'externalUrl must be an absolute URL' })
  externalUrl?: string;

  @IsOptional()
  @IsString()
  artifactId?: string;

  @IsOptional()
  @IsEnum(CollaborationDocumentKind)
  kind?: CollaborationDocumentKind;

  @IsOptional()
  @IsEnum(CollaborationDocumentStatus)
  status?: CollaborationDocumentStatus;

  @IsOptional()
  @IsBoolean()
  clientVisible?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

export class ReviewCollaborationDocumentDto {
  @IsEnum(CollaborationDocumentStatus)
  status!: CollaborationDocumentStatus;

  @IsOptional()
  @IsString()
  reviewNote?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}
