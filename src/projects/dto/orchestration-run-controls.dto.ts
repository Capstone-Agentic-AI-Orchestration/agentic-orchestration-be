import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class OrchestrationRunControlsDto {
  @IsOptional()
  @IsInt()
  @Min(25_000)
  @Max(1_000_000)
  tokenBudget?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  maxRetries?: number;
}
