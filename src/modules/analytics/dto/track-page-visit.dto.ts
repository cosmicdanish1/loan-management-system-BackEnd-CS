import { IsString, IsOptional, IsNumber, IsBoolean } from 'class-validator';

export class TrackPageVisitDto {
  @IsString()
  session_id: string;

  @IsOptional()
  @IsString()
  page_name?: string;

  @IsOptional()
  @IsString()
  window_title?: string;

  @IsOptional()
  @IsString()
  route_path?: string;

  @IsOptional()
  @IsString()
  component_name?: string;

  @IsOptional()
  @IsNumber()
  page_load_time_ms?: number;

  @IsOptional()
  @IsString()
  referrer_page?: string;
}

export class EndPageVisitDto {
  @IsString()
  session_id: string;

  @IsString()
  page_name: string;

  @IsOptional()
  @IsNumber()
  duration_seconds?: number;

  @IsOptional()
  @IsBoolean()
  is_bounce?: boolean;

  @IsOptional()
  @IsNumber()
  scroll_depth_percentage?: number;

  @IsOptional()
  @IsNumber()
  interactions_count?: number;
}