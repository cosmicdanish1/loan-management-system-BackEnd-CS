// Who may call the analytics endpoints (ES-617). Tracking posts come from every signed-in user's app and every app reads
// /analytics/config, so those stay open to any role. Reading everybody's analytics and changing the analytics settings
// are administrator work.
import 'reflect-metadata';
import { AnalyticsTrackingController } from '../../../src/modules/analytics/controllers/analytics-tracking.controller';
import { ROLES_KEY } from '../../../src/common/decorators/roles.decorator';
import { RoleGuard } from '../../../src/modules/auth/guards/role.guard';

const proto = AnalyticsTrackingController.prototype as any;
const roles = (method: string): string[] | undefined => Reflect.getMetadata(ROLES_KEY, proto[method]);
const guards = (method: string): any[] => Reflect.getMetadata('__guards__', proto[method]) ?? [];
const isAdminOnly = (method: string) => (roles(method) ?? []).map(String).some((r) => /admin/i.test(r)) && guards(method).includes(RoleGuard);

describe('Analytics controller: open to every signed-in user', () => {
  it.each(['startSession', 'trackSession', 'endSession', 'trackPageVisit', 'endPageVisit', 'trackFeatureUsage', 'trackError', 'trackErrorAlias', 'getAnalyticsConfig', 'healthCheck'])(
    '%s needs no special role', (m) => {
      expect(typeof proto[m]).toBe('function');
      expect(roles(m)).toBeUndefined();
      expect(guards(m)).not.toContain(RoleGuard);
    });
});

describe('Analytics controller: administrator only', () => {
  it.each(['getAnalyticsStatus', 'getUserAnalytics', 'getAllUsersAnalytics', 'exportUserAnalytics', 'updateAnalyticsConfig', 'updateAnalyticsSettings', 'resolveError'])(
    '%s is limited to administrators', (m) => {
      expect(typeof proto[m]).toBe('function');
      expect(isAdminOnly(m)).toBe(true);
    });
});
