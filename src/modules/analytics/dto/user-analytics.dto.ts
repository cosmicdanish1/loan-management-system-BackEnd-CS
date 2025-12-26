import { IsString, IsOptional, IsDateString, IsNumber, IsIn } from 'class-validator';

export class UserAnalyticsQueryDto {
  @IsOptional()
  @IsString()
  username?: string; // System username

  @IsOptional()
  @IsNumber()
  user_id?: number; // System user ID

  @IsOptional()
  @IsString()
  member_number?: string; // Member number

  @IsOptional()
  @IsDateString()
  start_date?: string; // Filter from date

  @IsOptional()
  @IsDateString()
  end_date?: string; // Filter to date

  @IsOptional()
  @IsNumber()
  limit?: number; // Limit results

  @IsOptional()
  @IsNumber()
  offset?: number; // Pagination offset

  @IsOptional()
  @IsIn(['sessions', 'page_visits', 'feature_usage', 'errors', 'all'])
  data_type?: string; // Type of data to retrieve
}

export class UserAnalyticsResponseDto {
  user_info: {
    user_id?: number;
    username?: string;
    member_number?: string;
    user_role?: string;
  };
  
  summary: {
    total_sessions: number;
    total_page_visits: number;
    total_feature_usage: number;
    total_errors: number;
    first_activity: Date;
    last_activity: Date;
    most_used_features: Array<{
      feature_name: string;
      usage_count: number;
    }>;
    error_summary: Array<{
      error_type: string;
      count: number;
      severity_breakdown: Record<string, number>;
    }>;
  };

  sessions?: Array<{
    session_id: string;
    login_time: Date;
    logout_time?: Date;
    duration_minutes?: number;
    device_info: {
      device_type?: string;
      browser_name?: string;
      os_name?: string;
      ip_address?: string;
    };
  }>;

  page_visits?: Array<{
    page_name: string;
    visit_start_time: Date;
    visit_end_time?: Date;
    duration_seconds?: number;
    session_id: string;
  }>;

  feature_usage?: Array<{
    feature_name: string;
    action_type: string;
    timestamp: Date;
    session_id: string;
    execution_time_ms?: number;
    success_status?: boolean;
  }>;

  errors?: Array<{
    error_id: string;
    error_message: string;
    error_type: string;
    severity_level: string;
    timestamp: Date;
    session_id: string;
    component_name?: string;
    resolved_status: boolean;
    resolution_notes?: string;
  }>;
}

export class BulkUserAnalyticsDto {
  @IsOptional()
  @IsDateString()
  start_date?: string;

  @IsOptional()
  @IsDateString()
  end_date?: string;

  @IsOptional()
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsString()
  sort_by?: string; // 'activity', 'errors', 'sessions'

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sort_order?: string;
}