import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { DesignGuidance } from '../../orchestration/graph/devflow.state';

export const DESIGN_THEMES: readonly DesignGuidance['theme'][] = [
  'black',
  'light',
  'system',
];

export const DESIGN_PRODUCT_FEELS: readonly DesignGuidance['productFeel'][] = [
  'enterprise',
  'playful',
  'editorial',
  'luxury',
  'operational',
];

export const DESIGN_LAYOUT_DENSITIES: readonly DesignGuidance['layoutDensity'][] = [
  'compact',
  'balanced',
  'spacious',
];

export const DESIGN_ACCESSIBILITY_LEVELS: readonly DesignGuidance['accessibilityLevel'][] = [
  'standard',
  'strict',
];

export class DesignSystemDto implements Partial<NonNullable<DesignGuidance['designSystem']>> {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  presetId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  palette?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  typography?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  spacing?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  layout?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  components?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  motion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  voice?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  brand?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  antiPatterns?: string[];
}

export class DesignGuidanceDto {
  @IsOptional()
  @IsIn(DESIGN_THEMES)
  theme?: DesignGuidance['theme'];

  @IsOptional()
  @IsIn(DESIGN_PRODUCT_FEELS)
  productFeel?: DesignGuidance['productFeel'];

  @IsOptional()
  @IsIn(DESIGN_LAYOUT_DENSITIES)
  layoutDensity?: DesignGuidance['layoutDensity'];

  @IsOptional()
  @IsIn(DESIGN_ACCESSIBILITY_LEVELS)
  accessibilityLevel?: DesignGuidance['accessibilityLevel'];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  forbiddenPatterns?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  notes?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => DesignSystemDto)
  designSystem?: DesignSystemDto;
}
