import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { DesignGuidanceDto } from './design-guidance.dto';

export class CreateProjectDto {
  @IsString()
  @MinLength(1, { message: 'companyName must not be empty' })
  companyName!: string;

  @IsString()
  @MinLength(10, { message: 'brief must be at least 10 characters' })
  brief!: string;

  @IsString()
  @MinLength(1, { message: 'stackKey must not be empty' })
  stackKey!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  groupId?: string;

  /**
   * The client company this project is for. Required — there is no such thing as a project
   * without a client.
   *
   * This used to be optional "so a project is never blocked at creation". The cost of that
   * convenience was a project that existed with nobody to deliver it to, plus a mop-up screen
   * to find and link them later. A client must be created (or an inquiry accepted) first; the
   * project is created inside that client's context.
   */
  @IsString({ message: 'clientId is required: create the client first, then the project' })
  @MinLength(1, { message: 'clientId is required: create the client first, then the project' })
  clientId!: string;

  @ValidateIf((input: CreateProjectDto) => Boolean(input.groupId) || Boolean(input.repositoryName))
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  repositoryName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(350)
  repositoryDescription?: string;

  /** When true, also provision a mobile (Expo/React Native) repository. Default: backend + frontend only. */
  @IsOptional()
  @IsBoolean()
  includeMobile?: boolean;

  /** Per-repo tech stack. Backend: nest|node. Frontend: next|react. Mobile: expo|react-native. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  backendStack?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  frontendStack?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  mobileStack?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => DesignGuidanceDto)
  designGuidance?: DesignGuidanceDto;
}
