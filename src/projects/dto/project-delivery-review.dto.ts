import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ProjectDeliveryReviewNoteDto {
  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}
