import { ArtifactReviewStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class ReviewArtifactDto {
  @IsEnum(ArtifactReviewStatus)
  reviewStatus!: ArtifactReviewStatus;

  @IsOptional()
  @IsString()
  reviewNote?: string;
}
