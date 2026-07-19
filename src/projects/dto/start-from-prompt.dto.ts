import { IsString, MinLength } from 'class-validator';

/**
 * Developer-initiated orchestration start. The prompt is the build requirement
 * and becomes the run's brief; unlike the PM `start` path this does not require
 * a completed kickoff — only a provisioned repository.
 */
export class StartFromPromptDto {
  @IsString()
  @MinLength(10, { message: 'Describe what to build in at least 10 characters' })
  prompt!: string;
}
