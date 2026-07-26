/**
 * Centralised voucher-number generator.
 *
 * Mirrors the legacy logic: a single `voucher_master` row holds one running
 * counter per voucher type — p_vchr_no / r_vchr_no / j_vchr_no / d_vchr_no.
 * Read the current value, increment the numeric part, write it back, and return
 * the formatted number (e.g. P00004, R00002, J00002, D00002).
 *
 * `runner` is anything exposing `.query()` — a TypeORM QueryRunner inside a
 * transaction (preferred, so the FOR UPDATE row lock holds and concurrent
 * callers can't get the same number), or a DataSource / EntityManager.
 *
 * NOTE: the migrated `voucher_master` currently contains duplicate rows, and
 * historically the counter was updated without a WHERE clause. To stay tolerant
 * of that we read the HIGHEST current value across all rows and write the new
 * value back to every row, keeping them in sync.
 */
export type VoucherType = 'P' | 'R' | 'J' | 'D';

interface SqlRunner {
  query(sql: string, params?: any[]): Promise<any>;
}

const COLUMN: Record<VoucherType, string> = {
  P: 'p_vchr_no',
  R: 'r_vchr_no',
  J: 'j_vchr_no',
  D: 'd_vchr_no',
};

export async function generateVoucherNo(runner: SqlRunner, type: VoucherType): Promise<string> {
  const col = COLUMN[type];
  if (!col) throw new Error(`Invalid voucher type: ${type}`);

  // Lock and read the highest existing value for this type.
  const rows = await runner.query(
    `SELECT ${col} AS last FROM voucher_master ORDER BY ${col} DESC LIMIT 1 FOR UPDATE`,
  );
  const last: string = rows?.[0]?.last ?? `${type}00000`;
  const nextNum = (parseInt(String(last).replace(/\D/g, ''), 10) || 0) + 1;
  const next = `${type}${String(nextNum).padStart(5, '0')}`;

  await runner.query(`UPDATE voucher_master SET ${col} = $1`, [next]);
  return next;
}
