import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface HeadOrderRow {
  code: string;
  headName: string;
  headType: string;
  position: number;
}

/** Position given to a head that is not in the order table; it sorts after every ordered head. */
const UNORDERED = 1_000_000;

/**
 * One global head order shared by every report that groups rows by account head
 * (Member Detail Ledger, Day Book, Cash Book, Consolidation, ...). Edited from the
 * "Report Head Order" window. Heads missing from the table go last, by code.
 */
@Injectable()
export class ReportHeadOrderService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Every head in current report order, including heads not yet positioned. */
  async getOrder(): Promise<HeadOrderRow[]> {
    const rows = await this.dataSource.query(`
      SELECT h.code,
             h.head_name AS "headName",
             COALESCE(h.headtype, '') AS "headType",
             COALESCE(o.position, ${UNORDERED}) AS position
      FROM headmaster h
      LEFT JOIN report_head_order o ON o.code = h.code
      WHERE h.code IS NOT NULL AND TRIM(h.code) <> ''
      ORDER BY COALESCE(o.position, ${UNORDERED}), h.code
    `);
    return rows.map((r: any, i: number) => ({
      code: String(r.code).trim(),
      headName: r.headName || r.code,
      headType: r.headType,
      position: i + 1,
    }));
  }

  /** Replace the order with the given head codes (first = top). Unknown codes are rejected. */
  async saveOrder(codes: string[]): Promise<{ saved: number }> {
    if (!Array.isArray(codes) || codes.length === 0) {
      throw new BadRequestException('codes must be a non-empty array of head codes');
    }
    const cleaned = codes.map((c) => String(c ?? '').trim());
    if (cleaned.some((c) => !c)) throw new BadRequestException('Empty head code in list');
    if (new Set(cleaned).size !== cleaned.length) throw new BadRequestException('Duplicate head code in list');

    const known: { code: string }[] = await this.dataSource.query(`SELECT code FROM headmaster`);
    const knownSet = new Set(known.map((k) => String(k.code).trim()));
    const unknown = cleaned.filter((c) => !knownSet.has(c));
    if (unknown.length) throw new BadRequestException(`Unknown head code(s): ${unknown.slice(0, 5).join(', ')}`);

    await this.dataSource.transaction(async (m) => {
      await m.query(`DELETE FROM report_head_order`);
      await m.query(
        `INSERT INTO report_head_order (code, position)
         SELECT c, p::int FROM unnest($1::text[]) WITH ORDINALITY AS t(c, p)`,
        [cleaned],
      );
    });
    return { saved: cleaned.length };
  }

  /** Back to plain head-code order. */
  async resetOrder(): Promise<{ saved: number }> {
    const rows: { code: string }[] = await this.dataSource.query(
      `SELECT code FROM headmaster WHERE code IS NOT NULL AND TRIM(code) <> '' ORDER BY code`,
    );
    return this.saveOrder(rows.map((r) => String(r.code).trim()));
  }

  /** code -> rank (1-based). Heads not present are not in the map; use {@link rankOf}. */
  async rankMap(): Promise<Map<string, number>> {
    const rows: { code: string; position: number }[] = await this.dataSource.query(
      `SELECT code, position FROM report_head_order`,
    );
    return new Map(rows.map((r) => [String(r.code).trim(), Number(r.position)]));
  }

  /**
   * Sort any list by head order. `getCode` extracts the head code from an item.
   * Ties and unordered heads fall back to code order so output is always stable.
   */
  async sortByHeadOrder<T>(items: T[], getCode: (item: T) => string | null | undefined): Promise<T[]> {
    const rank = await this.rankMap();
    const rankOf = (code: string) => rank.get(code) ?? UNORDERED;
    return [...items].sort((a, b) => {
      const ca = String(getCode(a) ?? '').trim();
      const cb = String(getCode(b) ?? '').trim();
      return rankOf(ca) - rankOf(cb) || ca.localeCompare(cb);
    });
  }
}
