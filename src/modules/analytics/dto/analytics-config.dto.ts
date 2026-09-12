import { IsString, IsOptional, IsBoolean } from 'class-validator';

export class UpdateAnalyticsConfigDto {
  @IsString()
  config_key: string;

  @IsString()
  config_value: string;

  @IsOptional()
  @IsString()
  updated_by?: string;
}

export class AnalyticsSettingsDto {
  @IsOptional()
  @IsBoolean()
  analytics_enabled?: boolean;

  @IsOptional()
  @IsString()
  tracking_level?: 'minimal' | 'standard' | 'detailed' | 'debug';

  @IsOptional()
  @IsString()
  data_retention_days?: string;

  @IsOptional()
  @IsBoolean()
  auto_cleanup_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  compression_enabled?: boolean;

  @IsOptional()
  @IsString()
  batch_size?: string;

  @IsOptional()
  @IsString()
  flush_interval_seconds?: string;

  @IsOptional()
  @IsString()
  max_queue_size?: string;

  @IsOptional()
  @IsString()
  error_threshold?: string;

  @IsOptional()
  @IsString()
  performance_threshold_ms?: string;

  @IsOptional()
  @IsBoolean()
  real_time_alerts_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  anonymize_user_data?: boolean;

  @IsOptional()
  @IsBoolean()
  exclude_sensitive_data?: boolean;
}