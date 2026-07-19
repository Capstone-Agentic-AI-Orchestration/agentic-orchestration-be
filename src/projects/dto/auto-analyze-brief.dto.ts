import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import { DesignGuidanceDto } from './design-guidance.dto';

export class AutoAnalyzeBriefDto {
  @IsString()
  companyName!: string;

  @IsString()
  @MinLength(3, { message: 'brief must be at least 3 characters' })
  brief!: string;

  @IsString()
  stackKey!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => DesignGuidanceDto)
  designGuidance?: DesignGuidanceDto;

  @IsOptional()
  @IsIn(['fast', 'thorough'])
  mode?: 'fast' | 'thorough';
}
