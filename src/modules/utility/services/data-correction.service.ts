import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface CorrectionResult {
  success: boolean;
  message: string;
  correctedRecords: number;
  errors: string[];
  rollbackAvailable: boolean;
}

export interface BulkCorrectionResult {
  totalAttempted: number;
  totalCorrected: number;
  totalFailed: number;
  results: CorrectionResult[];
  summary: string;
}

export interface OrphanedRecordFix {
  recordType: 'loan' | 'deposit' | 'payment' | 'transaction';
  recordId: number;
  action: 'delete' | 'reassign' | 'archive';
  newParentId?: number;
}

export interface BalanceCorrectionRequest {
  accountType: 'loan' | 'deposit';
  accountId: number;
  correctedBalance: number;
  reason: string;
  createAdjustmentEntry: boolean;
}

const SWITCHED_OFF =
  'Automatic data correction is switched off. It was written for tables the society does not use, and running it on the ' +
  'live member, loan and ledger records could change real accounts without a voucher. Use "Data Consistency Check" to ' +
  'find a problem, then correct that record from its own screen (a voucher, Change Member Office, Loan screens) so the ' +
  'correction is recorded.';

/**
 * Retired (ES-427). The correction routines worked on the empty ORM tables (members, loan_accounts, transactions),
 * so they never changed anything real. Pointing them at member_master / loan_master / ledger would turn them into
 * tools that delete or rewrite real accounts with no voucher, so every action now refuses with a clear reason.
 */
@Injectable()
export class DataCorrectionService {
  private readonly logger = new Logger(DataCorrectionService.name);

  private refuse(action: string): never {
    this.logger.warn(`Refused data correction request: ${action}`);
    throw new BadRequestException(SWITCHED_OFF);
  }

  async autoFixConsistencyIssues(): Promise<BulkCorrectionResult> { return this.refuse('auto-fix'); }
  async fixOrphanedRecords(_fixes: OrphanedRecordFix[]): Promise<CorrectionResult> { return this.refuse('orphaned records'); }
  async correctBalanceDiscrepancies(_corrections: BalanceCorrectionRequest[]): Promise<CorrectionResult> { return this.refuse('balance discrepancies'); }
  async removeDuplicateRecords(
    _recordType: 'member' | 'loan' | 'deposit',
    _keepStrategy: 'oldest' | 'newest' | 'manual',
    _manualKeepIds?: number[],
  ): Promise<CorrectionResult> { return this.refuse('remove duplicates'); }
  async fixDataIntegrityIssues(): Promise<CorrectionResult> { return this.refuse('fix integrity'); }
  async recalculateAllBalances(): Promise<CorrectionResult> { return this.refuse('recalculate balances'); }
}
