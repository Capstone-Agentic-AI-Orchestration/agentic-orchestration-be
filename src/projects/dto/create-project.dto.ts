import { Type } from 'class-transformer';
import { IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
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
  @ValidateNested()
  @Type(() => DesignGuidanceDto)
  designGuidance?: DesignGuidanceDto;
}
