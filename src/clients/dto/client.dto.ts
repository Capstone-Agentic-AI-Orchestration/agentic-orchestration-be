import { ClientStatus } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateClientDto {
  @IsString()
  @MinLength(1, { message: 'name must not be empty' })
  @MaxLength(160)
  name!: string;

  /**
   * The team workspace that owns this client. Required — a client with no workspace is invisible
   * to the switcher and its projects have nobody to belong to, so the column is NOT NULL and
   * this rejects the request rather than letting the database do it.
   */
  @IsString()
  @MaxLength(64)
  groupId!: string;

  @IsOptional()
  @IsEnum(ClientStatus)
  status?: ClientStatus;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  primaryContactName?: string;

  @IsOptional()
  @IsEmail({}, { message: 'primaryContactEmail must be a valid email address' })
  primaryContactEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

export class UpdateClientDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'name must not be empty' })
  @MaxLength(160)
  name?: string;

  /** Moves the client to another workspace, or assigns one the backfill could not infer. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  groupId?: string;

  @IsOptional()
  @IsEnum(ClientStatus)
  status?: ClientStatus;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  primaryContactName?: string;

  @IsOptional()
  @IsEmail({}, { message: 'primaryContactEmail must be a valid email address' })
  primaryContactEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

export class AddClientContactDto {
  @IsUUID('4', { message: 'profileId must be a profile id' })
  profileId!: string;

  @IsOptional()
  isPrimary?: boolean;
}

/**
 * Moving a project to a different client.
 *
 * No longer nullable: `clientId: null` used to mean "unlink", and that state no longer exists —
 * a project belongs to a client for its whole life. The service rejects null as well, so a
 * caller that skips validation gets a clear message rather than a not-null violation.
 */
export class SetProjectClientDto {
  @IsString({ message: 'clientId is required: a project must belong to a client' })
  @MinLength(1, { message: 'clientId is required: a project must belong to a client' })
  clientId!: string;
}
