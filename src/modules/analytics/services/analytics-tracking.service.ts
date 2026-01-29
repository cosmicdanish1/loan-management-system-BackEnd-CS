import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserSession } from '../entities/user-session.entity';
import { PageVisit } from '../entities/page-visit.entity';
import { FeatureUsage } from '../entities/feature-usage.entity';
import { ErrorLog } from '../entities/error-log.entity';
import { AnalyticsConfig } from '../entities/analytics-config.entity';
import { TrackSessionDto, EndSessionDto } from '../dto/track-session.dto';
import { TrackPageVisitDto, EndPageVisitDto } from '../dto/track-page-visit.dto';
import { TrackFeatureUsageDto } from '../dto/track-feature-usage.dto';
import { TrackErrorDto, ResolveErrorDto } from '../dto/track-error.dto';
import { UpdateAnalyticsConfigDto, AnalyticsSettingsDto } from '../dto/analytics-config.dto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class AnalyticsTrackingService {
  private readonly logger = new Logger(AnalyticsTrackingService.name);
  private isAnalyticsEnabled = false;
  private trackingLevel = 'standard';

  constructor(
    @InjectRepository(UserSession, 'analytics')
    private userSessionRepository: Repository<UserSession>,
    @InjectRepository(PageVisit, 'analytics')
    private pageVisitRepository: Repository<PageVisit>,
    @InjectRepository(FeatureUsage, 'analytics')
    private featureUsageRepository: Repository<FeatureUsage>,
    @InjectRepository(ErrorLog, 'analytics')
    private errorLogRepository: Repository<ErrorLog>,
    @InjectRepository(AnalyticsConfig, 'analytics')
    private analyticsConfigRepository: Repository<AnalyticsConfig>,
  ) {
    this.loadConfiguration();
  }

  // Load configuration from database
  private async loadConfiguration() {
    try {
      const configs = await this.analyticsConfigRepository.find();
      const configMap = new Map(configs.map(c => [c.config_key, c.config_value]));

      this.isAnalyticsEnabled = configMap.get('analytics_enabled') === 'true';
      this.trackingLevel = configMap.get('tracking_level') || 'standard';

      this.logger.log(`Analytics configuration loaded: enabled=${this.isAnalyticsEnabled}, level=${this.trackingLevel}`);
    } catch (error) {
      this.logger.error('Failed to load analytics configuration:', error);
    }
  }

  // Check if analytics is enabled and should track this event
  private shouldTrack(level: 'minimal' | 'standard' | 'detailed' | 'debug' = 'standard'): boolean {
    if (!this.isAnalyticsEnabled) return false;

    const levels = ['minimal', 'standard', 'detailed', 'debug'];
    const currentLevelIndex = levels.indexOf(this.trackingLevel);
    const requiredLevelIndex = levels.indexOf(level);

    return currentLevelIndex >= requiredLevelIndex;
  }

  // Session tracking
  async trackSession(dto: TrackSessionDto): Promise<{ success: boolean; session_id?: string }> {
    try {
      if (!this.shouldTrack('minimal')) {
        return { success: false };
      }

      const session = this.userSessionRepository.create({
        ...dto,
        login_time: new Date(),
        is_active: true,
      });

      const savedSession = await this.userSessionRepository.save(session);

      this.logger.log(`Session tracked: ${dto.session_id} for user ${dto.username}`);
      return { success: true, session_id: savedSession.session_id };
    } catch (error) {
      this.logger.error('Failed to track session:', error);
      return { success: false };
    }
  }

  async endSession(dto: EndSessionDto): Promise<{ success: boolean }> {
    try {
      if (!this.shouldTrack('minimal')) {
        return { success: false };
      }

      await this.userSessionRepository.update(
        { session_id: dto.session_id },
        {
          logout_time: dto.logout_time ? new Date(dto.logout_time) : new Date(),
          is_active: false,
        }
      );

      this.logger.log(`Session ended: ${dto.session_id}`);
      return { success: true };
    } catch (error) {
      this.logger.error('Failed to end session:', error);
      return { success: false };
    }
  }

  // Page visit tracking
  async trackPageVisit(dto: TrackPageVisitDto): Promise<{ success: boolean; visit_id?: number }> {
    try {
      if (!this.shouldTrack('standard')) {
        return { success: false };
      }

      const pageVisit = this.pageVisitRepository.create({
        ...dto,
        visit_start_time: new Date(),
      });

      const savedVisit = await this.pageVisitRepository.save(pageVisit);

      this.logger.debug(`Page visit tracked: ${dto.page_name} for session ${dto.session_id}`);
      return { success: true, visit_id: savedVisit.id };
    } catch (error) {
      this.logger.error('Failed to track page visit:', error);
      return { success: false };
    }
  }

  async endPageVisit(dto: EndPageVisitDto): Promise<{ success: boolean }> {
    try {
      if (!this.shouldTrack('standard')) {
        return { success: false };
      }

      // Find the most recent page visit for this session and page
      const pageVisit = await this.pageVisitRepository.findOne({
        where: {
          session_id: dto.session_id,
          page_name: dto.page_name,
          visit_end_time: null,
        },
        order: { visit_start_time: 'DESC' },
      });

      if (pageVisit) {
        await this.pageVisitRepository.update(pageVisit.id, {
          visit_end_time: new Date(),
          duration_seconds: dto.duration_seconds,
          is_bounce: dto.is_bounce,
          scroll_depth_percentage: dto.scroll_depth_percentage,
          interactions_count: dto.interactions_count,
        });

        this.logger.debug(`Page visit ended: ${dto.page_name} for session ${dto.session_id}`);
      }

      return { success: true };
    } catch (error) {
      this.logger.error('Failed to end page visit:', error);
      return { success: false };
    }
  }

  // Feature usage tracking
  async trackFeatureUsage(dto: TrackFeatureUsageDto): Promise<{ success: boolean; usage_id?: number }> {
    try {
      if (!this.shouldTrack('standard')) {
        return { success: false };
      }

      const featureUsage = this.featureUsageRepository.create({
        ...dto,
        timestamp: new Date(),
      });

      const savedUsage = await this.featureUsageRepository.save(featureUsage);

      this.logger.debug(`Feature usage tracked: ${dto.feature_name}/${dto.action_type} for session ${dto.session_id}`);
      return { success: true, usage_id: savedUsage.id };
    } catch (error) {
      this.logger.error('Failed to track feature usage:', error);
      return { success: false };
    }
  }

  // Error tracking
  async trackError(dto: TrackErrorDto): Promise<{ success: boolean; error_id?: string }> {
    try {
      // Always track errors regardless of analytics settings
      const errorId = dto.error_id || uuidv4();

      // Check if this error already exists
      const existingError = await this.errorLogRepository.findOne({
        where: { error_id: errorId },
      });

      if (existingError) {
        // Update occurrence count and last occurrence
        await this.errorLogRepository.update(existingError.id, {
          occurrence_count: existingError.occurrence_count + 1,
          last_occurrence: new Date(),
        });

        this.logger.warn(`Error occurrence updated: ${errorId} (count: ${existingError.occurrence_count + 1})`);
        return { success: true, error_id: errorId };
      }

      // Create new error log
      const errorLog = this.errorLogRepository.create({
        ...dto,
        error_id: errorId,
        timestamp: new Date(),
        first_occurrence: new Date(),
        last_occurrence: new Date(),
      });

      await this.errorLogRepository.save(errorLog);

      this.logger.error(`Error tracked: ${errorId} - ${dto.error_message}`);
      return { success: true, error_id: errorId };
    } catch (error) {
      this.logger.error('Failed to track error:', error);
      return { success: false };
    }
  }

  async resolveError(dto: ResolveErrorDto): Promise<{ success: boolean }> {
    try {
      await this.errorLogRepository.update(
        { error_id: dto.error_id },
        {
          resolved_status: true,
          resolved_by: dto.resolved_by,
          resolved_at: new Date(),
          resolution_notes: dto.resolution_notes,
        }
      );

      this.logger.log(`Error resolved: ${dto.error_id} by ${dto.resolved_by}`);
      return { success: true };
    } catch (error) {
      this.logger.error('Failed to resolve error:', error);
      return { success: false };
    }
  }

  // Configuration management
  async getAnalyticsConfig(): Promise<AnalyticsConfig[]> {
    try {
      return await this.analyticsConfigRepository.find({
        where: { is_user_configurable: true },
        order: { config_key: 'ASC' },
      });
    } catch (error) {
      this.logger.error('Failed to get analytics config:', error);
      return [];
    }
  }

  async updateAnalyticsConfig(dto: UpdateAnalyticsConfigDto): Promise<{ success: boolean }> {
    try {
      await this.analyticsConfigRepository.update(
        { config_key: dto.config_key },
        {
          config_value: dto.config_value,
          updated_by: dto.updated_by,
          updated_at: new Date(),
        }
      );

      // Reload configuration
      await this.loadConfiguration();

      this.logger.log(`Analytics config updated: ${dto.config_key} = ${dto.config_value}`);
      return { success: true };
    } catch (error) {
      this.logger.error('Failed to update analytics config:', error);
      return { success: false };
    }
  }

  async updateAnalyticsSettings(settings: AnalyticsSettingsDto, updatedBy: string): Promise<{ success: boolean }> {
    try {
      const updates = Object.entries(settings).filter(([_, value]) => value !== undefined);

      for (const [key, value] of updates) {
        await this.updateAnalyticsConfig({
          config_key: key,
          config_value: String(value),
          updated_by: updatedBy,
        });
      }

      this.logger.log(`Analytics settings updated by ${updatedBy}: ${updates.length} settings`);
      return { success: true };
    } catch (error) {
      this.logger.error('Failed to update analytics settings:', error);
      return { success: false };
    }
  }

  // Analytics status
  async getAnalyticsStatus(): Promise<{
    enabled: boolean;
    tracking_level: string;
    active_sessions: number;
    total_errors: number;
    unresolved_errors: number;
  }> {
    try {
      const activeSessions = await this.userSessionRepository.count({
        where: { is_active: true },
      });

      const totalErrors = await this.errorLogRepository.count();
      const unresolvedErrors = await this.errorLogRepository.count({
        where: { resolved_status: false },
      });

      return {
        enabled: this.isAnalyticsEnabled,
        tracking_level: this.trackingLevel,
        active_sessions: activeSessions,
        total_errors: totalErrors,
        unresolved_errors: unresolvedErrors,
      };
    } catch (error) {
      this.logger.error('Failed to get analytics status:', error);
      return {
        enabled: false,
        tracking_level: 'unknown',
        active_sessions: 0,
        total_errors: 0,
        unresolved_errors: 0,
      };
    }
  }

  // User-specific analytics methods
  async getUserAnalytics(query: {
    username?: string;
    user_id?: number;
    member_number?: string;
    start_date?: string;
    end_date?: string;
    limit?: number;
    offset?: number;
    data_type?: string;
  }): Promise<any> {
    try {
      const { username, user_id, member_number, start_date, end_date, limit = 100, offset = 0, data_type = 'all' } = query;

      // Build base where conditions
      const whereConditions: any = {};
      if (username) whereConditions.username = username;
      if (user_id) whereConditions.user_id = user_id;
      if (member_number) whereConditions.member_number = member_number;

      // Get user info from sessions
      const userSession = await this.userSessionRepository.findOne({
        where: whereConditions,
        order: { created_at: 'DESC' },
      });

      if (!userSession) {
        return {
          success: false,
          message: 'User not found in analytics data',
        };
      }

      const result: any = {
        user_info: {
          user_id: userSession.user_id,
          username: userSession.username,
          member_number: userSession.member_number,
          user_role: userSession.user_role,
        },
        summary: {},
      };

      // Get sessions data
      if (data_type === 'all' || data_type === 'sessions') {
        let sessionQuery = this.userSessionRepository.createQueryBuilder('session')
          .where('1=1');

        if (username) sessionQuery = sessionQuery.andWhere('session.username = :username', { username });
        if (user_id) sessionQuery = sessionQuery.andWhere('session.user_id = :user_id', { user_id });
        if (member_number) sessionQuery = sessionQuery.andWhere('session.member_number = :member_number', { member_number });
        if (start_date) sessionQuery = sessionQuery.andWhere('session.login_time >= :start_date', { start_date });
        if (end_date) sessionQuery = sessionQuery.andWhere('session.login_time <= :end_date', { end_date });

        const sessions = await sessionQuery
          .orderBy('session.login_time', 'DESC')
          .limit(limit)
          .offset(offset)
          .getMany();

        result.sessions = sessions.map(session => ({
          session_id: session.session_id,
          login_time: session.login_time,
          logout_time: session.logout_time,
          duration_minutes: session.session_duration_minutes,
          device_info: {
            device_type: session.device_type,
            browser_name: session.browser_name,
            os_name: session.os_name,
            ip_address: session.ip_address,
          },
        }));

        result.summary.total_sessions = sessions.length;
      }

      // Get page visits data
      if (data_type === 'all' || data_type === 'page_visits') {
        const sessionIds = await this.userSessionRepository.find({
          where: whereConditions,
          select: ['session_id'],
        });

        const sessionIdList = sessionIds.map(s => s.session_id);

        if (sessionIdList.length > 0) {
          let pageQuery = this.pageVisitRepository.createQueryBuilder('visit')
            .where('visit.session_id IN (:...sessionIds)', { sessionIds: sessionIdList });

          if (start_date) pageQuery = pageQuery.andWhere('visit.visit_start_time >= :start_date', { start_date });
          if (end_date) pageQuery = pageQuery.andWhere('visit.visit_start_time <= :end_date', { end_date });

          const pageVisits = await pageQuery
            .orderBy('visit.visit_start_time', 'DESC')
            .limit(limit)
            .offset(offset)
            .getMany();

          result.page_visits = pageVisits.map(visit => ({
            page_name: visit.page_name,
            visit_start_time: visit.visit_start_time,
            visit_end_time: visit.visit_end_time,
            duration_seconds: visit.duration_seconds,
            session_id: visit.session_id,
          }));

          result.summary.total_page_visits = pageVisits.length;
        }
      }

      // Get feature usage data
      if (data_type === 'all' || data_type === 'feature_usage') {
        const sessionIds = await this.userSessionRepository.find({
          where: whereConditions,
          select: ['session_id'],
        });

        const sessionIdList = sessionIds.map(s => s.session_id);

        if (sessionIdList.length > 0) {
          let featureQuery = this.featureUsageRepository.createQueryBuilder('usage')
            .where('usage.session_id IN (:...sessionIds)', { sessionIds: sessionIdList });

          if (start_date) featureQuery = featureQuery.andWhere('usage.timestamp >= :start_date', { start_date });
          if (end_date) featureQuery = featureQuery.andWhere('usage.timestamp <= :end_date', { end_date });

          const featureUsage = await featureQuery
            .orderBy('usage.timestamp', 'DESC')
            .limit(limit)
            .offset(offset)
            .getMany();

          result.feature_usage = featureUsage.map(usage => ({
            feature_name: usage.feature_name,
            action_type: usage.action_type,
            timestamp: usage.timestamp,
            session_id: usage.session_id,
            execution_time_ms: usage.execution_time_ms,
            success_status: usage.success_status,
          }));

          result.summary.total_feature_usage = featureUsage.length;

          // Get most used features
          const featureStats = await this.featureUsageRepository
            .createQueryBuilder('fu')
            .select('fu.feature_name', 'feature_name')
            .addSelect('COUNT(*)', 'usage_count')
            .where('fu.session_id IN (:...sessionIds)', { sessionIds: sessionIdList })
            .groupBy('fu.feature_name')
            .orderBy('usage_count', 'DESC')
            .limit(10)
            .getRawMany();

          result.summary.most_used_features = featureStats;
        }
      }

      // Get errors data
      if (data_type === 'all' || data_type === 'errors') {
        const sessionIds = await this.userSessionRepository.find({
          where: whereConditions,
          select: ['session_id'],
        });

        const sessionIdList = sessionIds.map(s => s.session_id);

        if (sessionIdList.length > 0) {
          let errorQuery = this.errorLogRepository.createQueryBuilder('error')
            .where('error.session_id IN (:...sessionIds)', { sessionIds: sessionIdList });

          if (start_date) errorQuery = errorQuery.andWhere('error.timestamp >= :start_date', { start_date });
          if (end_date) errorQuery = errorQuery.andWhere('error.timestamp <= :end_date', { end_date });

          const errors = await errorQuery
            .orderBy('error.timestamp', 'DESC')
            .limit(limit)
            .offset(offset)
            .getMany();

          result.errors = errors.map(error => ({
            error_id: error.error_id,
            error_message: error.error_message,
            error_type: error.error_type,
            severity_level: error.severity_level,
            timestamp: error.timestamp,
            session_id: error.session_id,
            component_name: error.component_name,
            resolved_status: error.resolved_status,
            resolution_notes: error.resolution_notes,
          }));

          result.summary.total_errors = errors.length;

          // Get error summary by type and severity
          const errorStats = await this.errorLogRepository
            .createQueryBuilder('el')
            .select('el.error_type', 'error_type')
            .addSelect('el.severity_level', 'severity_level')
            .addSelect('COUNT(*)', 'count')
            .where('el.session_id IN (:...sessionIds)', { sessionIds: sessionIdList })
            .groupBy('el.error_type, el.severity_level')
            .getRawMany();

          const errorSummary = {};
          errorStats.forEach(stat => {
            if (!errorSummary[stat.error_type]) {
              errorSummary[stat.error_type] = {
                error_type: stat.error_type,
                count: 0,
                severity_breakdown: {},
              };
            }
            errorSummary[stat.error_type].count += parseInt(stat.count);
            errorSummary[stat.error_type].severity_breakdown[stat.severity_level] = parseInt(stat.count);
          });

          result.summary.error_summary = Object.values(errorSummary);
        }
      }

      // Get activity date range
      const firstActivity = await this.userSessionRepository.findOne({
        where: whereConditions,
        order: { login_time: 'ASC' },
      });

      const lastActivity = await this.userSessionRepository.findOne({
        where: whereConditions,
        order: { login_time: 'DESC' },
      });

      result.summary.first_activity = firstActivity?.login_time;
      result.summary.last_activity = lastActivity?.login_time;

      return {
        success: true,
        data: result,
        message: 'User analytics retrieved successfully',
      };

    } catch (error) {
      this.logger.error('Failed to get user analytics:', error);
      return {
        success: false,
        message: 'Failed to retrieve user analytics',
        error: error.message,
      };
    }
  }

  async getAllUsersAnalytics(query: {
    start_date?: string;
    end_date?: string;
    limit?: number;
    sort_by?: string;
    sort_order?: string;
  }): Promise<any> {
    try {
      const { start_date, end_date, limit = 50, sort_order = 'desc' } = query;

      // SQL query to get users with session count, error count and feature usage count in one go
      // We use subqueries for counts to avoid multiplying rows during joins
      let sql = `
        SELECT 
          us.user_id,
          us.username,
          us.member_number,
          us.user_role,
          MAX(us.login_time) as last_activity,
          COUNT(DISTINCT us.session_id) as session_count,
          (SELECT COUNT(*) FROM analytics_error_logs el 
           WHERE el.session_id IN (SELECT session_id FROM analytics_user_sessions WHERE user_id = us.user_id)) as error_count,
          (SELECT COUNT(*) FROM analytics_feature_usage fu 
           WHERE fu.session_id IN (SELECT session_id FROM analytics_user_sessions WHERE user_id = us.user_id)) as feature_usage_count
        FROM analytics_user_sessions us
        WHERE 1=1
      `;

      const params: any[] = [];
      if (start_date) {
        sql += ` AND us.login_time >= $${params.length + 1}`;
        params.push(start_date);
      }
      if (end_date) {
        sql += ` AND us.login_time <= $${params.length + 1}`;
        params.push(end_date);
      }

      sql += ` GROUP BY us.user_id, us.username, us.member_number, us.user_role`;
      sql += ` ORDER BY last_activity ${sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC'}`;
      sql += ` LIMIT $${params.length + 1}`;
      params.push(limit);

      const users = await this.userSessionRepository.query(sql, params);

      const result = users.map(user => ({
        user_id: user.user_id,
        username: user.username,
        member_number: user.member_number,
        user_role: user.user_role,
        last_activity: user.last_activity,
        session_count: parseInt(user.session_count),
        error_count: parseInt(user.error_count),
        feature_usage_count: parseInt(user.feature_usage_count),
      }));

      return {
        success: true,
        data: result,
        total: result.length,
        message: 'All users analytics retrieved successfully',
      };

    } catch (error) {
      this.logger.error('Failed to get all users analytics:', error);
      return {
        success: false,
        message: 'Failed to retrieve all users analytics',
        error: error.message,
      };
    }
  }
}