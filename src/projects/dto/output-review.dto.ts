import { ArtifactOutputReviewStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class ReviewArtifactOutputDto {
  @IsEnum(ArtifactOutputReviewStatus)
  status!: ArtifactOutputReviewStatus;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsString()
  assignedToId?: string;
}

export class PublishArtifactOutputDto {
  @IsOptional()
  @IsString()
  displayName?: string;
}
