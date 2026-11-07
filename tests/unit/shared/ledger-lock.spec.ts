import { lockLedgerIds, LEDGER_ID_LOCK_KEY } from '../../../src/modules/shared/utils/ledger-lock';

// ES-445: every writer that hands out ledgerid / trans_no must take the SAME transaction-level lock first
describe('shared/ledger-lock', () => {
  it('takes one transaction-level advisory lock on the shared key', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await lockLedgerIds({ query });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls[0][1]).toEqual([LEDGER_ID_LOCK_KEY]);
  });
  it('uses the same key every time, so two writers exclude each other', async () => {
    const a = jest.fn().mockResolvedValue([]);
    const b = jest.fn().mockResolvedValue([]);
    await lockLedgerIds({ query: a });
    await lockLedgerIds({ query: b });
    expect(a.mock.calls[0][1]).toEqual(b.mock.calls[0][1]);
  });
  it('does not swallow a database error (a failed lock must stop the posting)', async () => {
    await expect(lockLedgerIds({ query: jest.fn().mockRejectedValue(new Error('db down')) })).rejects.toThrow('db down');
  });
});
