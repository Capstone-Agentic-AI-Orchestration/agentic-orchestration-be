import { IsOptional, IsString } from 'class-validator';

export class ReviewInquiryDto {
  @IsOptional()
  @IsString()
  reviewNote?: string;
}
