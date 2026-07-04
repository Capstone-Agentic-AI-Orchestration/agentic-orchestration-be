import { IsString, MinLength } from 'class-validator';

export class AutoAnalyzeBriefDto {
  @IsString()
  companyName!: string;

  @IsString()
  @MinLength(3, { message: 'brief must be at least 3 characters' })
  brief!: string;

  @IsString()
  stackKey!: string;
}
