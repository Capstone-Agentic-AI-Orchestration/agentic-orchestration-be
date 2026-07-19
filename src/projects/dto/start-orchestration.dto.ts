import { Type } from 'class-transformer';
import { IsOptional, ValidateNested } from 'class-validator';
import { DesignGuidanceDto } from './design-guidance.dto';

export class StartOrchestrationDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => DesignGuidanceDto)
  designGuidance?: DesignGuidanceDto;
}
