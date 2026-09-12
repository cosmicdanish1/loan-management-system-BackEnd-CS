import { IsString, IsOptional, IsNumber } from 'class-validator';

export class TrackErrorDto {
  @IsString()
  session_id: string;

  @IsOptional()
  @IsString()
  error_id?: string;

  @IsOptional()
  @IsString()
  error_type?: string; // 'javascript', 'api', 'database', 'validation', 'network'

  @IsOptional()
  @IsString()
  severity_level?: string; // 'low', 'medium', 'high', 'critical'

  @IsString()
  error_message: string;

  @IsOptional()
  @IsString()
  error_code?: string;

  @IsOptional()
  @IsString()
  stack_trace?: string;

  @IsOptional()
  @IsString()
  component_name?: string;

  @IsOptional()
  @IsString()
  file_name?: string;

  @IsOptional()
  @IsNumber()
  line_number?: number;

  @IsOptional()
  @IsNumber()
  column_number?: number;

  @IsOptional()
  @IsString()
  user_action_before_error?: string;

  @IsOptional()
  @IsString()
  browser_console_logs?: string;

  @IsOptional()
  @IsString()
  network_status?: string;
}

export class ResolveErrorDto {
  @IsString()
  error_id: string;

  @IsString()
  resolved_by: string;

  @IsOptional()
  @IsString()
  resolution_notes?: string;
}