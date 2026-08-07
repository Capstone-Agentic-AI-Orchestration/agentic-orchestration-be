import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { RUNTIME_ADAPTER_KINDS, RuntimeAdapterKind } from '../runtime-machine.types';

export class CompleteRegistrationDto {
  /** Sent exactly as the user typed it; normalized server-side before lookup. */
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  code!: string;

  @IsString()
  @MaxLength(200)
  name!: string;

  /** `process.platform` — win32 | darwin | linux | … */
  @IsString()
  @MaxLength(40)
  os!: string;

  /** `process.arch` — x64 | arm64 | … */
  @IsString()
  @MaxLength(40)
  arch!: string;

  @IsString()
  @MaxLength(40)
  runtimeVersion!: string;
}

/**
 * One probed CLI as the daemon reports it.
 *
 * Note what is absent: the daemon strips `status` and the resolved executable path before sending,
 * so the server never receives a filesystem path and must derive status itself.
 */
export class HeartbeatAdapterDto {
  @IsIn(RUNTIME_ADAPTER_KINDS as unknown as string[])
  kind!: RuntimeAdapterKind;

  @IsString()
  @MaxLength(200)
  displayCommand!: string;

  /** Null when the CLI is missing or would not run. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  version!: string | null;

  @IsBoolean()
  authenticated!: boolean;

  @IsObject()
  capabilities!: Record<string, unknown>;
}

export class HeartbeatDto {
  @IsString()
  @MaxLength(40)
  runtimeVersion!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HeartbeatAdapterDto)
  adapters!: HeartbeatAdapterDto[];
}

/**
 * Access mode arrives nested inside `capabilities`, not at the top level.
 *
 * Worth stating because a flat DTO plus `forbidNonWhitelisted` would reject every valid client —
 * the shipped daemon's shape is fixed and cannot be adjusted to suit the server.
 */
export class ResourceCapabilitiesDto {
  @IsIn(['READ_ONLY', 'READ_WRITE'])
  access!: 'READ_ONLY' | 'READ_WRITE';

  @IsOptional()
  @IsBoolean()
  filesystem?: boolean;
}

export class RegisterResourceDto {
  /** Client-generated (`res_<base64url>`), so treat it as untrusted input. */
  @IsString()
  @MinLength(4)
  @MaxLength(120)
  opaqueId!: string;

  @IsString()
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(200)
  fingerprint!: string;

  @ValidateNested()
  @Type(() => ResourceCapabilitiesDto)
  capabilities!: ResourceCapabilitiesDto;
}

export class TaskHeartbeatDto {
  @IsString()
  @MaxLength(200)
  leaseToken!: string;
}

export class CompleteTaskDto {
  @IsString()
  @MaxLength(200)
  leaseToken!: string;

  @IsBoolean()
  succeeded!: boolean;

  /**
   * Present only on success, and potentially large — `output` can reach 5MB, which is why this route
   * needs a raised body limit.
   */
  @IsOptional()
  @IsObject()
  result?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  error?: string;
}

export class CreatePairingCodeDto {
  /** Optional: the console already tracks a selected team workspace and can name it explicitly. */
  @IsOptional()
  @IsString()
  groupId?: string;
}
