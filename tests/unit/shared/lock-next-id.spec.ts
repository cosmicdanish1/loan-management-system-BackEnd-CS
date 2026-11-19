import { lockNextId, lockLedgerIds } from '../../../src/modules/shared/utils/ledger-lock';

// ES-495: every writer that hands out MAX(col)+1 ids takes the same advisory-lock key "<table>.<col>".
describe('lockNextId', () => {
  const mk = () => { const calls: Array<[string, any[] | undefined]> = []; return { calls, runner: { query: async (sql: string, p?: any[]) => { calls.push([sql, p]); return []; } } }; };

  it('takes the lock with the key <table>.<col>', async () => {
    const { calls, runner } = mk();
    await lockNextId(runner, 'transactions', 'trans_no');
    expect(calls).toEqual([['SELECT pg_advisory_xact_lock(hashtext($1))', ['transactions.trans_no']]]);
  });

  it('uses the same key for vouchers no matter which service asks', async () => {
    const a = mk(); const b = mk();
    await lockNextId(a.runner, 'vouchers', 'id');
    await lockNextId(b.runner, 'vouchers', 'id');
    expect(a.calls).toEqual(b.calls);
    expect(a.calls[0][1]).toEqual(['vouchers.id']);
  });

  it('for the ledger also takes the shared ledger id lock', async () => {
    const { calls, runner } = mk();
    await lockNextId(runner, 'ledger', 'ledgerid');
    expect(calls.map((c) => c[1])).toEqual([['ledger.ledgerid'], ['ledger.ids']]);
    const l = mk();
    await lockLedgerIds(l.runner);
    expect(l.calls[0][1]).toEqual(['ledger.ids']);
  });
});
