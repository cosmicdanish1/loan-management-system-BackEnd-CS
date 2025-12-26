import { IsString, IsOptional, IsNumber, IsBoolean, IsDateString } from 'class-validator';

export class TrackSessionDto {
  @IsString()
  session_id: string;

  @IsOptional()
  @IsNumber()
  user_id?: number; // System user ID

  @IsOptional()
  @IsString()
  username?: string; // System username

  @IsOptional()
  @IsString()
  member_number?: string; // Member number (if applicable)

  @IsOptional()
  @IsString()
  user_role?: string; // User role

  @IsOptional()
  @IsString()
  ip_address?: string;

  @IsOptional()
  @IsString()
  user_agent?: string;

  @IsOptional()
  @IsString()
  device_type?: string;

  @IsOptional()
  @IsString()
  browser_name?: string;

  @IsOptional()
  @IsString()
  browser_version?: string;

  @IsOptional()
  @IsString()
  os_name?: string;

  @IsOptional()
  @IsString()
  os_version?: string;

  @IsOptional()
  @IsString()
  screen_resolution?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  app_version?: string;
}

export class EndSessionDto {
  @IsString()
  session_id: string;

  @IsOptional()
  @IsDateString()
  logout_time?: string;
}