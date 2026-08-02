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
 * Linking a project to a client, or clearing it.
 *
 * `clientId: null` is a meaningful value (unlink), not an omission, so the field is required and
 * explicitly nullable rather than optional.
 */
export class SetProjectClientDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  clientId!: string | null;
}
