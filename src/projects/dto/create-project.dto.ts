import { IsString, MinLength } from 'class-validator';

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
}
