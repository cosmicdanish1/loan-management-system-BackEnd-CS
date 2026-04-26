import { IsString, IsNotEmpty, IsOptional, Length } from 'class-validator';

export class ActivateLicenseDto {
  @IsString()
  @IsNotEmpty()
  @Length(19, 19, { message: 'License key must be in format XXXX-XXXX-XXXX-XXXX' })
  key: string;

  @IsOptional()
  @IsString()
  machine_id?: string;
}

export class GenerateLicenseDto {
  @IsString()
  @IsNotEmpty()
  customer_name: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class LicenseStatusResponse {
  status: 'active' | 'grace' | 'expired' | 'not_activated';
  days_remaining: number;
  grace_days_remaining: number;
  activated_at: Date | null;
  expires_at: Date | null;
  grace_ends_at: Date | null;
  customer_name: string | null;
  message: string;
}
