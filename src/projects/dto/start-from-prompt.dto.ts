import { Type } from 'class-transformer';
import { IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import { OrchestrationModelSelectionDto } from './orchestration-model-selection.dto';
import { OrchestrationRunControlsDto } from './orchestration-run-controls.dto';

/**
 * Developer-initiated orchestration start. The prompt is the build requirement
 * and becomes the run's brief; unlike the PM `start` path this does not require
 * a completed kickoff — only a provisioned repository.
 */
export class StartFromPromptDto {
  @IsString()
  @MinLength(10, { message: 'Describe what to build in at least 10 characters' })
  prompt!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => OrchestrationModelSelectionDto)
  modelSelection?: OrchestrationModelSelectionDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => OrchestrationRunControlsDto)
  runControls?: OrchestrationRunControlsDto;
}
