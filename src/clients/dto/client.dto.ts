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
