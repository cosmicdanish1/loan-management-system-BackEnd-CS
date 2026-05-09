import { IsString, IsNotEmpty, IsOptional, Matches } from 'class-validator';

export class ActivateLicenseDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^PWT0-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i, {
    message: 'License key must be in format PWT0-XXXX-XXXX-XXXX-XXXX',
  })
  key: string;

  @IsOptional()
  @IsString()
  machine_id?: string;
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
