import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateInquiryDto {
  @IsString()
  @MinLength(1, { message: 'companyName must not be empty' })
  companyName!: string;

  @IsString()
  @MinLength(1, { message: 'contactName must not be empty' })
  contactName!: string;

  @IsEmail({}, { message: 'email must be a valid email address' })
  email!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsString()
  @MinLength(10, { message: 'brief must be at least 10 characters' })
  brief!: string;

  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'stackKey must not be empty' })
  stackKey?: string;

  @IsOptional()
  @IsString()
  budgetRange?: string;

  @IsOptional()
  @IsString()
  timeline?: string;
}
