import { Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MODEL_ID_MESSAGE = 'Choose a valid Vercel AI Gateway model';

export class OrchestrationModelOverridesDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(MODEL_ID_PATTERN, { message: MODEL_ID_MESSAGE })
  requirements?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(MODEL_ID_PATTERN, { message: MODEL_ID_MESSAGE })
  contract?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(MODEL_ID_PATTERN, { message: MODEL_ID_MESSAGE })
  frontend?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(MODEL_ID_PATTERN, { message: MODEL_ID_MESSAGE })
  backend?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(MODEL_ID_PATTERN, { message: MODEL_ID_MESSAGE })
  database?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(MODEL_ID_PATTERN, { message: MODEL_ID_MESSAGE })
  architecture?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(MODEL_ID_PATTERN, { message: MODEL_ID_MESSAGE })
  mobile?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(MODEL_ID_PATTERN, { message: MODEL_ID_MESSAGE })
  qa?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(MODEL_ID_PATTERN, { message: MODEL_ID_MESSAGE })
  security?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(MODEL_ID_PATTERN, { message: MODEL_ID_MESSAGE })
  critique?: string;
}

export class OrchestrationModelSelectionDto {
  @IsString()
  @MaxLength(160)
  @Matches(MODEL_ID_PATTERN, { message: MODEL_ID_MESSAGE })
  defaultModel!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => OrchestrationModelOverridesDto)
  overrides?: OrchestrationModelOverridesDto;
}
