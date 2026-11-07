import { BadRequestException } from '@nestjs/common';
import { DayBookService } from '../../../src/modules/daybook/daybook.service';

const q = (data: any[] = []) => ({ select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), getMany: jest.fn().mockResolvedValue(data), getRawOne: jest.fn().mockResolvedValue({ maxTransNo: 1 }) });
const mk = (data: any[] = []) => {
  const ledger: any = { createQueryBuilder: jest.fn(() => q(data)), create: jest.fn((v) => v), save: jest.fn(async (v) => v) };
  const tx: any = { create: jest.fn((v) => v), save: jest.fn(async (v) => v), createQueryBuilder: jest.fn(() => q()) };
  return { svc: new DayBookService(tx, ledger, {} as any, {} as any), ledger, tx };
};
const rows = (...a: Array<[string, string]>) => a.map(([trans_type, trans_amt]) => ({ trans_type, trans_amt }));
const calc = (data: any[]) => mk(data).svc.calculateMemberInterest({ memberCode: '1', fromDate: '2026-01-01', toDate: '2026-01-31', interestRate: 12 } as any);

describe('DayBook member interest minimum balance (ES-416)', () => {
  it('a balance that falls to exactly 0 stays the minimum; later deposits do not replace it', async () => {
    expect((await calc(rows(['CR', '100'], ['DR', '100'], ['CR', '50']))).minBalance).toBe(0);
  });
  it('a normal minimum is the lowest running balance; an overdrawn one is kept negative with no interest', async () => {
    expect((await calc(rows(['CR', '100'], ['DR', '30'], ['CR', '50']))).minBalance).toBe(70);
    const r = await calc(rows(['CR', '10'], ['DR', '40']));
    expect(r.minBalance).toBe(-30);
    expect(r.principalAmount).toBe(0);
    expect(r.interestAmount).toBe(0);
  });
  it('no rows gives 0', async () => expect((await calc([])).minBalance).toBe(0));
});

describe('DayBook interest payment (ES-121, ES-353)', () => {
  const pay = (amt: any, svc = mk().svc) => svc.payInterestToMember({ memberCode: '1001', interestAmount: amt, paymentDate: '2026-03-31' } as any);
  it('credits the member savings head A001 on the ledger and the transaction, never Cash In Hand (A1001)', async () => {
    const { svc, ledger, tx } = mk();
    await pay(75, svc);
    expect(ledger.save).toHaveBeenCalledWith(expect.objectContaining({ trans_type: 'CR', code: 'A001', trans_amt: 75 }));
    expect(tx.save).toHaveBeenCalledWith(expect.objectContaining({ code: 'A001', trans_amt: '75' }));
  });
  it('an amount sent as text is accepted as a number', async () => {
    const { svc, ledger } = mk();
    await pay('12.5', svc);
    expect(ledger.save).toHaveBeenCalledWith(expect.objectContaining({ trans_amt: 12.5 }));
  });
  it('non-numeric, empty, null, zero, negative and Infinity are a 400 and nothing is saved', async () => {
    for (const bad of ['abc', '', null, undefined, 0, -5, Infinity, NaN]) {
      const { svc, ledger, tx } = mk();
      await expect(pay(bad, svc)).rejects.toBeInstanceOf(BadRequestException);
      expect(ledger.save).not.toHaveBeenCalled();
      expect(tx.save).not.toHaveBeenCalled();
    }
  });
});
