import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class ApproveGateDto {
  @IsBoolean()
  approved!: boolean;

  @IsOptional()
  @IsString()
  notes?: string;
}
