import { Controller, Post, Get, Put, Body, Query, UseGuards, Request } from '@nestjs/common';
import { AnalyticsTrackingService } from '../services/analytics-tracking.service';
import { TrackSessionDto, EndSessionDto } from '../dto/track-session.dto';
import { TrackPageVisitDto, EndPageVisitDto } from '../dto/track-page-visit.dto';
import { TrackFeatureUsageDto } from '../dto/track-feature-usage.dto';
import { TrackErrorDto, ResolveErrorDto } from '../dto/track-error.dto';
import { UpdateAnalyticsConfigDto, AnalyticsSettingsDto } from '../dto/analytics-config.dto';
import { UserAnalyticsQueryDto, BulkUserAnalyticsDto } from '../dto/user-analytics.dto';

@Controller('analytics')
export class AnalyticsTrackingController {
  constructor(private readonly analyticsService: AnalyticsTrackingService) {}

  // Session tracking endpoints
  @Post('session/start')
  async startSession(@Body() dto: TrackSessionDto) {
    try {
      const result = await this.analyticsService.trackSession(dto);
      return {
        success: result.success,
        session_id: result.session_id,
        message: result.success ? 'Session started successfully' : 'Session tracking disabled',
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to start session tracking',
        error: error.message,
      };
    }
  }

  @Post('track/session')
  async trackSession(@Body() dto: TrackSessionDto) {
    return this.startSession(dto);
  }

  @Post('session/end')
  async endSession(@Body() dto: EndSessionDto) {
    try {
      const result = await this.analyticsService.endSession(dto);
      return {
        success: result.success,
        message: result.success ? 'Session ended successfully' : 'Session tracking disabled',
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to end session tracking',
        error: error.message,
      };
    }
  }

  // Page visit tracking endpoints
  @Post('page/visit')
  async trackPageVisit(@Body() dto: TrackPageVisitDto) {
    try {
      const result = await this.analyticsService.trackPageVisit(dto);
      return {
        success: result.success,
        visit_id: result.visit_id,
        message: result.success ? 'Page visit tracked successfully' : 'Page tracking disabled',
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to track page visit',
        error: error.message,
      };
    }
  }

  @Post('page/end')
  async endPageVisit(@Body() dto: EndPageVisitDto) {
    try {
      const result = await this.analyticsService.endPageVisit(dto);
      return {
        success: result.success,
        message: result.success ? 'Page visit ended successfully' : 'Page tracking disabled',
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to end page visit',
        error: error.message,
      };
    }
  }

  // Feature usage tracking endpoint
  @Post('feature/usage')
  async trackFeatureUsage(@Body() dto: TrackFeatureUsageDto) {
    try {
      const result = await this.analyticsService.trackFeatureUsage(dto);
      return {
        success: result.success,
        usage_id: result.usage_id,
        message: result.success ? 'Feature usage tracked successfully' : 'Feature tracking disabled',
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to track feature usage',
        error: error.message,
      };
    }
  }

  // Error tracking endpoints
  @Post('error/track')
  async trackError(@Body() dto: TrackErrorDto) {
    try {
      const result = await this.analyticsService.trackError(dto);
      return {
        success: result.success,
        error_id: result.error_id,
        message: result.success ? 'Error tracked successfully' : 'Error tracking failed',
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to track error',
        error: error.message,
      };
    }
  }

  @Post('track/error')
  async trackErrorAlias(@Body() dto: TrackErrorDto) {
    return this.trackError(dto);
  }

  @Post('error/resolve')
  async resolveError(@Body() dto: ResolveErrorDto) {
    try {
      const result = await this.analyticsService.resolveError(dto);
      return {
        success: result.success,
        message: result.success ? 'Error resolved successfully' : 'Failed to resolve error',
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to resolve error',
        error: error.message,
      };
    }
  }

  // Configuration endpoints
  @Get('config')
  async getAnalyticsConfig() {
    try {
      const config = await this.analyticsService.getAnalyticsConfig();
      return {
        success: true,
        data: config,
        message: 'Analytics configuration retrieved successfully',
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to get analytics configuration',
        error: error.message,
      };
    }
  }

  @Put('config')
  async updateAnalyticsConfig(@Body() dto: UpdateAnalyticsConfigDto) {
    try {
      const result = await this.analyticsService.updateAnalyticsConfig(dto);
      return {
        success: result.success,
        message: result.success ? 'Configuration updated successfully' : 'Failed to update configuration',
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to update analytics configuration',
        error: error.message,
      };
    }
  }

  @Put('settings')
  async updateAnalyticsSettings(@Body() settings: AnalyticsSettingsDto, @Request() req: any) {
    try {
      const updatedBy = req.user?.username || 'system';
      const result = await this.analyticsService.updateAnalyticsSettings(settings, updatedBy);
      return {
        success: result.success,
        message: result.success ? 'Settings updated successfully' : 'Failed to update settings',
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to update analytics settings',
        error: error.message,
      };
    }
  }

  // Status endpoint
  @Get('status')
  async getAnalyticsStatus() {
    try {
      const status = await this.analyticsService.getAnalyticsStatus();
      return {
        success: true,
        data: status,
        message: 'Analytics status retrieved successfully',
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to get analytics status',
        error: error.message,
      };
    }
  }

  // Health check endpoint
  @Get('health')
  async healthCheck() {
    return {
      success: true,
      message: 'Analytics service is running',
      timestamp: new Date().toISOString(),
    };
  }

  // User-specific analytics endpoints
  @Get('user')
  async getUserAnalytics(@Query() query: UserAnalyticsQueryDto) {
    try {
      const result = await this.analyticsService.getUserAnalytics(query);
      return {
        success: result.success,
        data: result.data,
        message: result.message,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to get user analytics',
        error: error.message,
      };
    }
  }

  @Get('users')
  async getAllUsersAnalytics(@Query() query: BulkUserAnalyticsDto) {
    try {
      const result = await this.analyticsService.getAllUsersAnalytics(query);
      return {
        success: result.success,
        data: result.data,
        total: result.total,
        message: result.message,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to get all users analytics',
        error: error.message,
      };
    }
  }

  // Export user analytics data
  @Get('user/export')
  async exportUserAnalytics(@Query() query: UserAnalyticsQueryDto) {
    try {
      const result = await this.analyticsService.getUserAnalytics({
        ...query,
        data_type: 'all',
        limit: 10000, // Large limit for export
      });

      if (!result.success) {
        return result;
      }

      // Format data for export
      const exportData = {
        export_info: {
          generated_at: new Date().toISOString(),
          user_info: result.data.user_info,
          date_range: {
            start_date: query.start_date,
            end_date: query.end_date,
          },
        },
        summary: result.data.summary,
        detailed_data: {
          sessions: result.data.sessions || [],
          page_visits: result.data.page_visits || [],
          feature_usage: result.data.feature_usage || [],
          errors: result.data.errors || [],
        },
      };

      return {
        success: true,
        data: exportData,
        message: 'User analytics exported successfully',
        export_format: 'json',
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to export user analytics',
        error: error.message,
      };
    }
  }
}