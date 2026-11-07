import { AnalyticsTrackingService } from '../../../src/modules/analytics/services/analytics-tracking.service';

describe('AnalyticsTrackingService', () => {
  let service: AnalyticsTrackingService;
  let userSessionRepo: any;
  let pageVisitRepo: any;
  let featureUsageRepo: any;
  let errorLogRepo: any;
  let analyticsConfigRepo: any;

  const mockRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((entity) => ({ ...entity })),
    save: jest.fn(async (entity) => ({ id: 1, ...entity })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    count: jest.fn().mockResolvedValue(0),
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getRawMany: jest.fn().mockResolvedValue([]),
    })),
  });

  beforeEach(() => {
    userSessionRepo = mockRepo();
    pageVisitRepo = mockRepo();
    featureUsageRepo = mockRepo();
    errorLogRepo = mockRepo();
    analyticsConfigRepo = mockRepo();

    // Default configuration: analytics enabled, standard tracking
    analyticsConfigRepo.find.mockResolvedValue([
      { config_key: 'analytics_enabled', config_value: 'true' },
      { config_key: 'tracking_level', config_value: 'standard' },
    ]);

    service = new AnalyticsTrackingService(
      userSessionRepo,
      pageVisitRepo,
      featureUsageRepo,
      errorLogRepo,
      analyticsConfigRepo,
    );
  });

  describe('Session tracking', () => {
    it('tracks user session when analytics is enabled', async () => {
      const dto = {
        session_id: 'sess-123',
        username: 'john_doe',
        user_id: 101,
        ip_address: '127.0.0.1',
      };

      const result = await service.trackSession(dto as any);

      expect(result.success).toBe(true);
      expect(userSessionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          session_id: 'sess-123',
          username: 'john_doe',
          is_active: true,
        }),
      );
      expect(userSessionRepo.save).toHaveBeenCalled();
    });

    it('returns success: false when analytics is disabled', async () => {
      // Re-initialize with disabled analytics
      analyticsConfigRepo.find.mockResolvedValueOnce([
        { config_key: 'analytics_enabled', config_value: 'false' },
      ]);
      const disabledService = new AnalyticsTrackingService(
        userSessionRepo,
        pageVisitRepo,
        featureUsageRepo,
        errorLogRepo,
        analyticsConfigRepo,
      );

      const result = await disabledService.trackSession({ session_id: 'sess-1' } as any);
      expect(result.success).toBe(false);
      expect(userSessionRepo.save).not.toHaveBeenCalled();
    });

    it('ends active session by setting is_active false and logout_time', async () => {
      const res = await service.endSession({ session_id: 'sess-123' });

      expect(res.success).toBe(true);
      expect(userSessionRepo.update).toHaveBeenCalledWith(
        { session_id: 'sess-123' },
        expect.objectContaining({ is_active: false }),
      );
    });
  });

  describe('Page visit and feature usage tracking', () => {
    it('tracks page visit start and records visit_start_time', async () => {
      const dto = {
        session_id: 'sess-1',
        page_name: 'MemberLedger',
        page_url: '/reports/member-ledger',
      };

      const res = await service.trackPageVisit(dto as any);
      expect(res.success).toBe(true);
      expect(pageVisitRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ page_name: 'MemberLedger' }),
      );
    });

    it('ends page visit with duration and interaction metrics', async () => {
      pageVisitRepo.findOne.mockResolvedValueOnce({ id: 42, session_id: 'sess-1' });

      const res = await service.endPageVisit({
        session_id: 'sess-1',
        page_name: 'MemberLedger',
        duration_seconds: 45,
        is_bounce: false,
        interactions_count: 5,
      });

      expect(res.success).toBe(true);
      expect(pageVisitRepo.update).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ duration_seconds: 45, interactions_count: 5 }),
      );
    });

    it('tracks feature usage action and saves event', async () => {
      const res = await service.trackFeatureUsage({
        session_id: 'sess-1',
        feature_name: 'VoucherExport',
        action_type: 'EXPORT_PDF',
      } as any);

      expect(res.success).toBe(true);
      expect(featureUsageRepo.save).toHaveBeenCalled();
    });
  });

  describe('Error tracking', () => {
    it('always tracks new errors even if analytics is disabled', async () => {
      // Configure disabled analytics
      analyticsConfigRepo.find.mockResolvedValueOnce([
        { config_key: 'analytics_enabled', config_value: 'false' },
      ]);
      const disabledService = new AnalyticsTrackingService(
        userSessionRepo,
        pageVisitRepo,
        featureUsageRepo,
        errorLogRepo,
        analyticsConfigRepo,
      );

      errorLogRepo.findOne.mockResolvedValueOnce(null); // new error

      const res = await disabledService.trackError({
        error_message: 'Unhandled DB error',
        stack_trace: 'Error at ...',
        severity: 'critical',
      } as any);

      expect(res.success).toBe(true);
      expect(res.error_id).toBeDefined();
      expect(errorLogRepo.save).toHaveBeenCalled();
    });

    it('increments occurrence_count when error with same error_id already exists', async () => {
      errorLogRepo.findOne.mockResolvedValueOnce({
        id: 10,
        error_id: 'ERR-500',
        occurrence_count: 3,
      });

      const res = await service.trackError({
        error_id: 'ERR-500',
        error_message: 'Repeated error',
      } as any);

      expect(res.success).toBe(true);
      expect(errorLogRepo.update).toHaveBeenCalledWith(
        10,
        expect.objectContaining({ occurrence_count: 4 }),
      );
    });

    it('resolves error by updating resolved_status and resolved_at', async () => {
      const res = await service.resolveError({
        error_id: 'ERR-500',
        resolved_by: 'admin',
        resolution_notes: 'Patched query syntax',
      });

      expect(res.success).toBe(true);
      expect(errorLogRepo.update).toHaveBeenCalledWith(
        { error_id: 'ERR-500' },
        expect.objectContaining({
          resolved_status: true,
          resolved_by: 'admin',
          resolution_notes: 'Patched query syntax',
        }),
      );
    });
  });

  describe('Configuration & Analytics status', () => {
    it('retrieves user configurable settings and updates status', async () => {
      userSessionRepo.count.mockResolvedValueOnce(5); // active sessions
      errorLogRepo.count
        .mockResolvedValueOnce(12) // total errors
        .mockResolvedValueOnce(2); // unresolved errors

      const status = await service.getAnalyticsStatus();

      expect(status.enabled).toBe(true);
      expect(status.active_sessions).toBe(5);
      expect(status.total_errors).toBe(12);
      expect(status.unresolved_errors).toBe(2);
    });

    it('updates individual setting and reloads config', async () => {
      const res = await service.updateAnalyticsConfig({
        config_key: 'tracking_level',
        config_value: 'detailed',
        updated_by: 'admin',
      });

      expect(res.success).toBe(true);
      expect(analyticsConfigRepo.update).toHaveBeenCalledWith(
        { config_key: 'tracking_level' },
        expect.objectContaining({ config_value: 'detailed' }),
      );
      // Reload called
      expect(analyticsConfigRepo.find).toHaveBeenCalled();
    });
  });
});
