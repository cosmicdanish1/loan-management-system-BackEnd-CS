export type AlertGroup = 'queries' | 'errors' | 'activity' | 'business' | 'digest';

export interface AlertParamDef {
    label: string;
    unit: string;
    default: number;
    min: number;
    max: number;
}

export interface AlertDef {
    key: string;
    group: AlertGroup;
    label: string;
    description: string;
    param?: AlertParamDef;
}

export const ALERT_GROUPS: { id: AlertGroup; label: string; description: string }[] = [
    { id: 'queries', label: 'Queries & Jira', description: 'Problems and questions raised from the Support Desk' },
    { id: 'errors', label: 'Errors & Crashes', description: 'Backend errors, slow calls, app errors and system health' },
    { id: 'activity', label: 'Activity', description: 'Who logged in and out, and failed sign-ins' },
    { id: 'business', label: 'Business events', description: 'Day-end, backups and licence' },
    { id: 'digest', label: 'Daily digest', description: 'One summary message each morning' },
];

/**
 * Every alert the backend can send. The key is what the code checks (AlertSettingsService.isEnabled)
 * and what the Settings window lists. Everything defaults to ON, which is how the alerts behaved
 * before this catalogue existed. Add an entry here when a new alert is built.
 */
export const ALERT_CATALOG: AlertDef[] = [
    { key: 'query.new', group: 'queries', label: 'New query raised', description: 'A user submitted a query in the Support Desk' },

    { key: 'error.backend', group: 'errors', label: 'Backend errors', description: 'Server errors (grouped; repeats are summarised every 10 min)' },
    {
        key: 'error.slow', group: 'errors', label: 'Slow API calls', description: 'A request took longer than the limit',
        param: { label: 'Slower than', unit: 'seconds', default: 5, min: 1, max: 120 },
    },
    { key: 'error.client', group: 'errors', label: 'Desktop app errors', description: 'Errors reported by the app on a user\'s PC' },
    { key: 'system.started', group: 'errors', label: 'Backend started', description: 'The backend server (re)started' },
    { key: 'system.db', group: 'errors', label: 'Database down / recovered', description: 'The database stopped answering, or came back' },

    { key: 'login.success', group: 'activity', label: 'Logins', description: 'A user signed in (name, PC, IP and MAC address)' },
    { key: 'logout', group: 'activity', label: 'Logouts', description: 'A user signed out, with session length' },
    {
        key: 'login.failed', group: 'activity', label: 'Failed logins', description: 'Repeated wrong passwords for the same account and PC',
        param: { label: 'Alert after', unit: 'failed attempts', default: 3, min: 1, max: 50 },
    },

    {
        key: 'presence.offline', group: 'activity', label: 'Session ended without logout', description: 'A user\'s app went quiet (closed, crashed or lost the network) without signing out',
        param: { label: 'Silent for', unit: 'minutes', default: 3, min: 1, max: 30 },
    },
    { key: 'presence.online', group: 'activity', label: 'Who is online now', description: 'The list posted when you press "Post to channels" in Settings' },
    { key: 'admin.user', group: 'activity', label: 'User accounts changed', description: 'A user was created, changed (role, enabled/disabled) or deleted' },
    { key: 'admin.rights', group: 'activity', label: 'Rights changed', description: 'Default rights of a user level were changed' },
    { key: 'admin.password', group: 'activity', label: 'Passwords changed', description: 'A user changed their own password, or an administrator reset one' },

    { key: 'dayend.done', group: 'business', label: 'Day-end completed', description: 'The day-end process finished' },
    { key: 'dayend.failed', group: 'business', label: 'Day-end failed', description: 'The day-end process failed and was rolled back' },
    { key: 'backup.ok', group: 'business', label: 'Backup succeeded', description: 'A database backup finished' },
    { key: 'backup.failed', group: 'business', label: 'Backup failed', description: 'A database backup failed' },
    {
        key: 'backup.missing', group: 'business', label: 'No recent backup', description: 'No successful backup for a long time',
        param: { label: 'After', unit: 'hours', default: 26, min: 2, max: 240 },
    },
    { key: 'licence.expiry', group: 'business', label: 'Licence expiring', description: 'At 30, 7 and 1 days before expiry, and on expiry' },

    {
        key: 'digest.daily', group: 'digest', label: 'Daily digest', description: 'Support, health, usage and business summary',
        param: { label: 'Send at', unit: 'o\'clock (0-23)', default: 8, min: 0, max: 23 },
    },
];

export const MASTER_KEY = 'master';

/** Plain on/off settings stored beside the alerts: master, the two destinations, and Jira ticket creation. */
export const EXTRA_KEYS = [MASTER_KEY, 'dest.telegram', 'dest.discord', 'jira.create'];

export const findAlert = (key: string): AlertDef | undefined => ALERT_CATALOG.find((a) => a.key === key);
