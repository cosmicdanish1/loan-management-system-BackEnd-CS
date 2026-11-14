import { JobGate, StatementPdfService, rowLines, wrapText } from '../../../src/modules/mobile/data/statement-pdf.service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('statement PDF (ES-226)', () => {
  describe('JobGate', () => {
    it('runs at most 2 jobs at once and the rest wait their turn', async () => {
      const gate = new JobGate(2, 10, 5000); let now = 0; let peak = 0;
      const job = async () => { now++; peak = Math.max(peak, now); await sleep(30); now--; return 1; };
      await Promise.all(Array.from({ length: 6 }, () => gate.run(job)));
      expect(peak).toBe(2); expect(gate.stats()).toEqual({ running: 0, waiting: 0 });
    });
    it('turns people away with PDF_BUSY when too many are already waiting', async () => {
      const gate = new JobGate(1, 1, 5000); const hold = gate.run(() => sleep(60)); const wait = gate.run(async () => 1);
      const err: any = await gate.run(async () => 1).catch((e) => e);
      expect(err.getStatus()).toBe(503); expect(err.getResponse()).toMatchObject({ code: 'PDF_BUSY', retryAfterSeconds: 5 });
      await Promise.all([hold, wait]);
    });
    it('a waiting job that is not served in time gets PDF_BUSY and frees its place', async () => {
      const gate = new JobGate(1, 5, 20); const hold = gate.run(() => sleep(120));
      const err: any = await gate.run(async () => 1).catch((e) => e);
      expect(err.getResponse().code).toBe('PDF_BUSY'); expect(gate.stats().waiting).toBe(0);
      await hold; expect(gate.stats().running).toBe(0);
    });
    it('a failing job still frees its slot', async () => {
      const gate = new JobGate(1, 5, 1000);
      await expect(gate.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
      expect(await gate.run(async () => 'ok')).toBe('ok');
    });
  });

  describe('layout helpers', () => {
    it('wraps long text at spaces and never exceeds the column', () => {
      const lines = wrapText('Salary deduction towards regular loan instalment for the month of March', 20);
      expect(lines.every((l) => l.length <= 20)).toBe(true); expect(lines.join(' ')).toBe('Salary deduction towards regular loan instalment for the month of March');
      expect(wrapText('', 20)).toEqual(['']); expect(wrapText('A'.repeat(45), 20).map((l) => l.length)).toEqual([20, 20, 5]);
    });
    it('a table row is a fixed-width line: date, particulars, debit, credit, balance; extra lines continue the particulars', () => {
      const [a, b] = rowLines({ date: '2026-03-05', head: 'Loan', particulars: 'EMI received for March salary deduction through payroll', debit: 0, credit: 12345.5, balance: 100 });
      expect(a.startsWith('05-03-2026')).toBe(true); expect(a).toContain('12,345.50'); expect(a).toContain('100.00');
      expect(a.length).toBe(b.length); expect(b.startsWith(' '.repeat(10))).toBe(true);
    });
  });

  describe('render', () => {
    const svc = new StatementPdfService({} as any, {} as any, {} as any, {} as any, {} as any, { get: (_k: string, d: any) => d } as any);
    const rows = Array.from({ length: 140 }, (_, i) => ({ date: '2026-03-05', head: 'Savings', particulars: `Entry number ${i} with a fairly long description to force wrapping onto a second line`, debit: i % 2 ? 100 : 0, credit: i % 2 ? 0 : 250.75, balance: 1000 + i }));
    const base = { societyName: 'EMP ESPAT EMPLOYEES CO-OP CREDIT SOCIETY LTD.', societyAddress: 'Sector 27A, Nigdi, Pradhikaran, Pune - 411044', memberNo: '900000001', memberName: 'Test Member', from: '2026-03-01', to: '2026-03-31', totalDebit: 7000, totalCredit: 17552.5 };

    it('makes a real multi-page PDF with a page footer', async () => {
      const pdf = await svc.render({ ...base, rows });
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      const pages = (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
      expect(pages).toBeGreaterThan(2);
    });
    it('an empty period still gives a valid one-page statement', async () => {
      const pdf = await svc.render({ ...base, rows: [], totalDebit: 0, totalCredit: 0 });
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-'); expect((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length).toBe(1);
    });
  });
});
