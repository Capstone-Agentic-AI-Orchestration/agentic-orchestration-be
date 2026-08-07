import { IsString, IsOptional } from 'class-validator';

export class CreateRuntimeProviderDto {
  @IsString()
  provider!: string;

  @IsString()
  label!: string;

  @IsString()
  apiKey!: string;

  @IsOptional()
  @IsString()
  baseUrl?: string;

  @IsOptional()
  @IsString()
  model?: string;
}

export class UpdateRuntimeProviderDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsString()
  baseUrl?: string;

  @IsOptional()
  @IsString()
  model?: string;
}

export class RuntimeProviderResponseDto {
  id!: string;
  provider!: string;
  label!: string;
  baseUrl?: string;
  model?: string;
  status!: string;
  createdAt!: Date;
  updatedAt!: Date;
}

