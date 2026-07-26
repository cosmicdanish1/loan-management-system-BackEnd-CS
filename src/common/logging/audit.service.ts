import { Injectable, Logger } from '@nestjs/common';
import { ServiceLogService } from './service-log.service';

export type AuditAction =
  | 'LOGIN'
  | 'LOGIN_FAILED'
  | 'LOGOUT'
  | 'VOUCHER_CREATED'
  | 'VOUCHER_PASSED'
  | 'VOUCHER_REVERSED'
  | 'LOAN_APPLIED'
  | 'LOAN_SANCTIONED'
  | 'LOAN_REPAID'
  | 'FD_OPENED'
  | 'FD_CLOSED'
  | 'RD_OPENED'
  | 'SB_OPENED'
  | 'MEMBER_CREATED'
  | 'MEMBER_UPDATED'
  | 'DAY_END_RUN'
  | 'INTEREST_POSTED'
  | 'BACKUP_TAKEN'
  | 'BACKUP_RESTORED'
  | 'LICENSE_ACTIVATED'
  | 'USER_CREATED'
  | 'USER_DISABLED'
  | 'PASSWORD_CHANGED'
  | 'ROLE_CREATED'
  | 'ROLE_UPDATED'
  | 'JOURNAL_TRANSFER'
  | 'DEMAND_GENERATED'
  | 'FINANCIAL_YEAR_CLOSED'
  | 'BALANCE_TRANSFER';

/** Route each audit action to the service partition it belongs to. */
const ACTION_DOMAIN: Record<AuditAction, string> = {
  LOGIN: 'auth',
  LOGIN_FAILED: 'auth',
  LOGOUT: 'auth',
  USER_CREATED: 'admin',
  USER_DISABLED: 'admin',
  PASSWORD_CHANGED: 'admin',
  ROLE_CREATED: 'admin',
  ROLE_UPDATED: 'admin',
  VOUCHER_CREATED: 'transactions',
  VOUCHER_PASSED: 'transactions',
  VOUCHER_REVERSED: 'transactions',
  JOURNAL_TRANSFER: 'transactions',
  DEMAND_GENERATED: 'transactions',
  BALANCE_TRANSFER: 'transactions',
  LOAN_APPLIED: 'loan',
  LOAN_SANCTIONED: 'loan',
  LOAN_REPAID: 'loan',
  FD_OPENED: 'interest',
  FD_CLOSED: 'interest',
  RD_OPENED: 'interest',
  SB_OPENED: 'interest',
  INTEREST_POSTED: 'interest',
  MEMBER_CREATED: 'member',
  MEMBER_UPDATED: 'member',
  DAY_END_RUN: 'day-end',
  FINANCIAL_YEAR_CLOSED: 'day-end',
  BACKUP_TAKEN: 'backup',
  BACKUP_RESTORED: 'backup',
  LICENSE_ACTIVATED: 'license',
};

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger('Audit');

  constructor(private readonly serviceLog: ServiceLogService) {}

  log(
    action: AuditAction,
    user: string,
    details: string,
    meta?: { clientIP?: string; requestId?: string; memberNo?: string; amount?: number },
  ): void {
    // 1) File (audit-*.log) — existing behaviour, unchanged.
    this.logger.log(
      JSON.stringify({
        action,
        user,
        details,
        ...meta,
        timestamp: new Date().toISOString(),
      }),
    );

    // 2) Structured DB row in the matching service partition (request_id auto-filled).
    //    Fire-and-forget: record() swallows its own errors, so audit never breaks.
    void this.serviceLog.record({
      service: ACTION_DOMAIN[action] ?? 'other',
      level: action.endsWith('_FAILED') ? 'warn' : 'info',
      action,
      message: details,
      metadata: { user, ...meta },
    });
  }
}
