// A new member number continues after the highest number in the new-member block (990,000,000 to 999,999,999),
// is never one a member already holds, and the block is big enough for 20 lakh members.
import { SequenceGeneratorService } from '../../../src/modules/shared/services/sequence-generator.service';

const FIRST = SequenceGeneratorService.MEMBER_BLOCK_FIRST;
const LAST = SequenceGeneratorService.MEMBER_BLOCK_LAST;

function mk(initiallyUsed: number[], counter: number | null = null) {
  const used = new Set<number>(initiallyUsed);
  let last = counter; // the stored counter row (null = no row yet)
  const maxInBlock = () => { const v = [...used].filter((n) => n >= FIRST && n <= LAST); return v.length ? Math.max(...v) : FIRST - 1; };
  const ds: any = {
    query: jest.fn(async (sql: string, p?: any[]) => {
      if (/INSERT INTO sequence_master/.test(sql)) {
        last = last === null ? maxInBlock() + 1 : Math.max(last, maxInBlock()) + 1;
        return [{ last_value: String(last) }];
      }
      if (/SELECT 1 FROM member_master WHERE mbno/.test(sql)) return used.has(Number(p![0])) ? [{ x: 1 }] : [];
      if (/SELECT COALESCE\(MAX\(mbno\)/.test(sql)) return [{ m: String(maxInBlock()) }];
      if (/FROM sequence_master WHERE sequence_key/.test(sql)) return last === null ? [] : [{ last_value: String(last) }];
      return [];
    }),
  };
  const take = async (svc: SequenceGeneratorService) => { const n = await svc.generateNextMemberNumber(); used.add(Number(n)); return n; };
  return { svc: new SequenceGeneratorService(ds, {} as any), ds, used, take };
}

describe('member number generator', () => {
  it('continues after the highest number of the new-member block (legacy last one: 990042382)', async () => {
    expect(await mk([990042381, 990042382, 30018289, 610031521]).svc.generateNextMemberNumber()).toBe('990042383');
  });

  it('the old series and the QA test numbers do not move the counter', async () => {
    expect(await mk([990042382, 30033311, 61007893, 9999962712]).svc.generateNextMemberNumber()).toBe('990042383');
  });

  it('an empty block starts at its first number', async () => {
    expect(await mk([30018289]).svc.generateNextMemberNumber()).toBe(String(FIRST));
  });

  it('the stored counter can never fall behind numbers that are already in the table', async () => {
    expect(await mk([990042382], 990000010).svc.generateNextMemberNumber()).toBe('990042383');
  });

  it('a number a member already holds is skipped (a counter ahead of a gap cannot repeat a number)', async () => {
    const { svc, ds } = mk([990042382], null);
    // the counter row says 990042400 but a member holds 990042401 that the max query cannot see
    let first = true;
    const orig = ds.query.getMockImplementation()!;
    ds.query.mockImplementation(async (sql: string, p?: any[]) => {
      if (/INSERT INTO sequence_master/.test(sql)) return [{ last_value: String(first ? 990042401 : 990042402) }, (first = false)].slice(0, 1);
      if (/SELECT 1 FROM member_master WHERE mbno/.test(sql)) return Number(p![0]) === 990042401 ? [{ x: 1 }] : [];
      return orig(sql, p);
    });
    expect(await svc.generateNextMemberNumber()).toBe('990042402');
  });

  it('the preview shows the same number without using the counter', async () => {
    const { svc, ds } = mk([990042382]);
    expect(await svc.peekNextMemberNumber()).toBe('990042383');
    expect(ds.query.mock.calls.some((c: any[]) => /INSERT INTO sequence_master/.test(c[0]))).toBe(false);
  });

  it('the number shown is the number the next save gets', async () => {
    const { svc } = mk([990042382]);
    const shown = await svc.peekNextMemberNumber();
    expect(await svc.generateNextMemberNumber()).toBe(shown);
  });

  it('1,000 new members in a row get 1,000 different, consecutive numbers (stress)', async () => {
    const { svc, take } = mk([990042382]);
    const got: number[] = [];
    for (let i = 0; i < 1000; i++) got.push(Number(await take(svc)));
    expect(new Set(got).size).toBe(1000);
    expect(got[0]).toBe(990042383);
    expect(got[999]).toBe(990043382);
  });

  it('20 lakh more members still fit in the block', () => {
    expect(LAST - 990042382).toBeGreaterThan(2_000_000);
    expect(LAST - FIRST + 1).toBe(10_000_000);
  });

  it('when the block is full the answer is a clear message, never a number outside it', async () => {
    await expect(mk([LAST]).svc.generateNextMemberNumber()).rejects.toThrow(/block is full/);
    await expect(mk([LAST]).svc.peekNextMemberNumber()).rejects.toThrow(/block is full/);
  });
});
