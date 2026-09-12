import { IsString, IsOptional, IsNumber, IsBoolean, IsObject } from 'class-validator';

export class TrackFeatureUsageDto {
  @IsString()
  session_id: string;

  @IsOptional()
  @IsString()
  feature_category?: string;

  @IsString()
  feature_name: string;

  @IsOptional()
  @IsString()
  sub_feature?: string;

  @IsString()
  action_type: string; // 'view', 'click', 'submit', 'download', 'print'

  @IsOptional()
  @IsObject()
  action_details?: any;

  @IsOptional()
  @IsNumber()
  execution_time_ms?: number;

  @IsOptional()
  @IsBoolean()
  success_status?: boolean;

  @IsOptional()
  @IsString()
  error_message?: string;

  @IsOptional()
  @IsObject()
  user_input_data?: any; // Anonymized form data structure

  @IsOptional()
  @IsNumber()
  result_count?: number;
}