import { Type } from 'class-transformer';
import { IsOptional, ValidateNested } from 'class-validator';
import { DesignGuidanceDto } from './design-guidance.dto';
import { OrchestrationModelSelectionDto } from './orchestration-model-selection.dto';

export class StartOrchestrationDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => DesignGuidanceDto)
  designGuidance?: DesignGuidanceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => OrchestrationModelSelectionDto)
  modelSelection?: OrchestrationModelSelectionDto;
}
