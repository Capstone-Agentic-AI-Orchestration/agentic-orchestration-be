import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class ShareArtifactDto {
  @IsBoolean()
  clientVisible!: boolean;

  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'displayName must not be empty' })
  displayName?: string;
}
