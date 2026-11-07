import { IsString, IsNotEmpty, IsOptional, Matches } from 'class-validator';

export class ActivateLicenseDto {
  @IsString()
  @IsNotEmpty()
  // PWT0-XXXX-XXXX-XXXX-XXXX (old format) or PWT1-... (signed key, about 120 characters, may contain spaces or line breaks)
  @Matches(/^\s*(PWT0-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}|PWT1-[A-Z0-9\s-]{20,300})\s*$/i, {
    message: 'License key must look like PWT1-XXXX-XXXX-... (or the old PWT0-XXXX-XXXX-XXXX-XXXX)',
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
