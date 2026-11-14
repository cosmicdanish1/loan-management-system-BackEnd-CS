import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { MemberLedgerService } from '../../member-ledger/member-ledger.service';
import { AppCodeService } from '../access/app-code.service';
import { ClientCtx } from '../access/access.types';
import { MobileAuditService } from '../audit/mobile-audit.service';
import { MOBILE_DS } from '../mobile.constants';
import { FeatureFlagService } from './feature-flag.service';
import { LEDGER_FREE_MONTHS, MemberCtx } from './member-data.service';
import { toLedgerEntry } from './member-view.mappers';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit');

/** DejaVu Sans Mono is bundled under backend/assets/fonts (same depth for src/ and dist/). */
const FONT_DIR = path.resolve(__dirname, '../../../../assets/fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'DejaVuSansMono.ttf');
const FONT_BOLD = path.join(FONT_DIR, 'DejaVuSansMono-Bold.ttf');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_STATEMENT_ROWS = 4000;

/** Monospace column widths in characters: date, particulars, debit, credit, balance (+ 4 single spaces) = 98. */
const COLS = { date: 10, part: 40, debit: 14, credit: 14, bal: 16 };
const LINE_CHARS = COLS.date + COLS.part + COLS.debit + COLS.credit + COLS.bal + 4;

/**
 * Lets at most `max` jobs run at once and a few wait their turn; everyone else is told to retry. pdfkit works in the same
 * Node process as the API, so an unlimited number of statements would slow the desktop for everybody (ES-226).
 */
export class JobGate {
  private running = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max = 2, private readonly maxWaiting = 10, private readonly waitMs = 20_000) {}

  private busy(): HttpException {
    return new HttpException({ statusCode: 503, code: 'PDF_BUSY', message: 'Many statements are being prepared right now. Please try again in a few seconds.', retryAfterSeconds: 5 }, 503);
  }

  private acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxWaiting) return Promise.reject(this.busy());
    return new Promise<void>((resolve, reject) => {
      const turn = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(turn);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(this.busy());
      }, this.waitMs);
      this.waiters.push(turn);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next(); // the slot passes straight to the next job
    else this.running--;
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await job();
    } finally {
      this.release();
    }
  }

  stats(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.waiters.length };
  }
}

export interface StatementRow {
  date: string; // YYYY-MM-DD
  head: string;
  particulars: string;
  debit: number | string; // the mappers give money as text ("1234.50")
  credit: number | string;
  balance: number | string | null;
}

const dmy = (d: string) => (DATE.test(d) ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : d);
const amount = (n: number | string | null | undefined) => (n === null || n === undefined ? '' : Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/** Cuts a text into lines of at most `width` characters, breaking at spaces where possible. */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  let rest = (text || '').replace(/\s+/g, ' ').trim();
  if (!rest) return [''];
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut < width / 2) cut = width;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

/** One printed table row as monospace lines (a long particulars text continues on extra lines). */
export function rowLines(r: StatementRow): string[] {
  const text = [r.head, r.particulars].filter(Boolean).join(' - ');
  const parts = wrapText(text, COLS.part);
  return parts.map((p, i) =>
    [
      (i === 0 ? dmy(r.date) : '').padEnd(COLS.date),
      p.padEnd(COLS.part),
      (i === 0 && Number(r.debit) ? amount(r.debit) : '').padStart(COLS.debit),
      (i === 0 && Number(r.credit) ? amount(r.credit) : '').padStart(COLS.credit),
      (i === 0 ? amount(r.balance) : '').padStart(COLS.bal),
    ].join(' '),
  );
}

/** Member ledger statement as a PDF in the legacy monospace letterhead layout (ES-226). */
@Injectable()
export class StatementPdfService {
  private readonly logger = new Logger(StatementPdfService.name);
  private readonly gate: JobGate;
  private readonly dailyCap: number;

  constructor(
    @InjectDataSource(MOBILE_DS) private readonly ds: DataSource,
    private readonly ledger: MemberLedgerService,
    private readonly appCode: AppCodeService,
    private readonly flags: FeatureFlagService,
    private readonly audit: MobileAuditService,
    config: ConfigService,
  ) {
    this.gate = new JobGate(Number(config.get('MOBILE_PDF_CONCURRENCY', 2)), Number(config.get('MOBILE_PDF_QUEUE', 10)));
    this.dailyCap = Number(config.get('MOBILE_PDF_DAILY_CAP', 10));
  }

  async statement(ctx: MemberCtx, q: { from: string; to: string }, approval: string | undefined, client: ClientCtx): Promise<{ pdf: Buffer; fileName: string }> {
    await this.flags.assertOn('statements');
    if (!DATE.test(q.from) || !DATE.test(q.to)) throw new BadRequestException('from and to must be YYYY-MM-DD');
    const from = new Date(q.from + 'T00:00:00');
    const to = new Date(q.to + 'T00:00:00');
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw new BadRequestException('Invalid date range');

    // Same privacy rule as the on-screen ledger: more than 12 months back needs the App Code approval.
    const limitDate = new Date();
    limitDate.setMonth(limitDate.getMonth() - LEDGER_FREE_MONTHS);
    if (from < limitDate) await this.appCode.requireApproval(ctx, 'LARGE_STATEMENT', approval);

    await this.assertUnderDailyCap(ctx.mbno);

    const pdf = await this.gate.run(async () => {
      const [report, society, member] = await Promise.all([
        this.ledger.getMemberDetailLedgerReport({ memberNumber: ctx.mbno, fromDate: q.from, toDate: q.to }),
        this.ds.query('SELECT * FROM society_details LIMIT 1').then((r: any[]) => r[0] || {}),
        this.ds
          .query(`SELECT COALESCE(NULLIF(trim(full_name), ''), trim(concat_ws(' ', f_name, m_name, l_name))) AS name FROM member_master WHERE mbno = $1`, [ctx.mbno])
          .then((r: any[]) => r[0] || {}),
      ]);
      const entries = report.entries.map((e: any) => toLedgerEntry(e));
      if (entries.length > MAX_STATEMENT_ROWS) {
        throw new BadRequestException({ statusCode: 400, code: 'STATEMENT_TOO_LARGE', message: 'That period has too many entries for one statement. Please choose a shorter period.' });
      }
      return this.render({
        societyName: society.name || 'EMP ESPAT EMPLOYEES CO-OP CREDIT SOCIETY LTD.',
        societyAddress: society.address || '',
        memberNo: ctx.mbno,
        memberName: member.name || '',
        from: q.from,
        to: q.to,
        rows: entries,
        totalDebit: Number(report.totalDebits) || 0,
        totalCredit: Number(report.totalCredits) || 0,
      });
    });

    await this.audit.log({ event: 'STATEMENT_PDF', result: 'OK', mbno: ctx.mbno, ...client, detail: { from: q.from, to: q.to, bytes: pdf.length } });
    return { pdf, fileName: `statement-${ctx.mbno}-${q.from}-to-${q.to}.pdf` };
  }

  private async assertUnderDailyCap(mbno: string): Promise<void> {
    const r: Array<{ n: number }> = await this.ds.query(
      `SELECT count(*)::int AS n FROM mobile_audit_log WHERE mbno = $1 AND event = 'STATEMENT_PDF' AND result = 'OK' AND at > now() - interval '24 hours'`,
      [mbno],
    );
    if ((r[0]?.n ?? 0) >= this.dailyCap) {
      throw new HttpException(
        { statusCode: 429, code: 'PDF_DAILY_LIMIT', message: `You can download ${this.dailyCap} statements in 24 hours. Please try again tomorrow or visit the office.` },
        429,
      );
    }
  }

  /** Renders the letterhead + table. Public so the layout can be tested without a database. */
  render(d: {
    societyName: string; societyAddress: string; memberNo: string; memberName: string; from: string; to: string;
    rows: StatementRow[]; totalDebit: number; totalCredit: number;
  }): Promise<Buffer> {
    const fontSize = 8.5;
    const lh = 11;
    const margin = 36;
    const doc = new PDFDocument({ size: 'A4', margin, bufferPages: true, info: { Title: 'Member Ledger Statement', Producer: 'Espat Society' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    doc.registerFont('Mono', FONT_REGULAR);
    doc.registerFont('MonoB', FONT_BOLD);

    const bottom = doc.page.height - margin - lh * 2; // room for the footer
    const center = (t: string) => ' '.repeat(Math.max(0, Math.floor((LINE_CHARS - t.length) / 2))) + t;
    const rule = '-'.repeat(LINE_CHARS);
    let y = margin;
    const put = (text: string, bold = false) => {
      doc.font(bold ? 'MonoB' : 'Mono').fontSize(fontSize).text(text, margin, y, { lineBreak: false });
      y += lh;
    };
    const tableHead = () => {
      put(rule);
      put(['Date'.padEnd(COLS.date), 'Particulars'.padEnd(COLS.part), 'Debit'.padStart(COLS.debit), 'Credit'.padStart(COLS.credit), 'Balance'.padStart(COLS.bal)].join(' '), true);
      put(rule);
    };
    const letterhead = () => {
      y = margin;
      put(center(d.societyName.slice(0, LINE_CHARS)), true);
      for (const l of wrapText(d.societyAddress, LINE_CHARS - 4)) if (l) put(center(l));
      put(rule);
      put(center('MEMBER LEDGER STATEMENT'), true);
      put(`Member : ${d.memberNo}  ${d.memberName}`.slice(0, LINE_CHARS));
      put(`Period : ${dmy(d.from)} to ${dmy(d.to)}`);
      tableHead();
    };

    letterhead();
    for (const r of d.rows) {
      const lines = rowLines(r);
      if (y + lines.length * lh > bottom) {
        doc.addPage();
        letterhead();
      }
      for (const l of lines) put(l);
    }
    if (!d.rows.length) put('No entries in this period.');
    if (y + lh * 4 > bottom) {
      doc.addPage();
      letterhead();
    }
    put(rule);
    put(`${'Total'.padEnd(COLS.date + COLS.part + 1)} ${amount(d.totalDebit).padStart(COLS.debit)} ${amount(d.totalCredit).padStart(COLS.credit)}`, true);
    put(rule);
    put('Computer generated statement. Balances are as recorded at the society office.');

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.font('Mono').fontSize(fontSize).text(`Page ${i + 1} of ${range.count}`.padStart(LINE_CHARS), margin, doc.page.height - margin - lh - 4, { lineBreak: false });
    }
    doc.end();
    return done.catch((e) => {
      this.logger.error(`Statement PDF failed: ${e?.message}`);
      throw e;
    });
  }
}
