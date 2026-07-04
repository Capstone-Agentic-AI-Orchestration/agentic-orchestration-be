import { IsOptional, IsString } from 'class-validator';

export class HandleRevisionDto {
  @IsOptional()
  @IsString()
  resolutionNote?: string;
}
