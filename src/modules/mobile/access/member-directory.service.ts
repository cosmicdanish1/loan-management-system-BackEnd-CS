import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MOBILE_DS } from '../mobile.constants';

export type PhoneStatus = 'OK' | 'MISSING' | 'INVALID' | 'SHARED';

export interface DirectoryMember {
  mbno: string;
  fullName: string;
  dob: string | null; // YYYY-MM-DD
  panLast4: string | null; // upper case
  phone10: string | null; // last 10 digits of the registered phone
  isActive: boolean;
}

/** More members than this on one number and the number is not trusted for call-back or OTP (PRD 9.3). */
export const SHARED_PHONE_LIMIT = 3;

/** Read-only access to the society member record for the mobile module (uses the small mobile pool). */
@Injectable()
export class MemberDirectoryService {
  constructor(@InjectDataSource(MOBILE_DS) private readonly ds: DataSource) {}

  async getMember(mbno: string): Promise<DirectoryMember | null> {
    if (!/^\d{1,18}$/.test(String(mbno))) return null;
    const rows: any[] = await this.ds.query(
      `SELECT mbno::text AS mbno,
              COALESCE(NULLIF(trim(full_name), ''), trim(concat_ws(' ', f_name, m_name, l_name))) AS full_name,
              to_char(dob, 'YYYY-MM-DD') AS dob,
              upper(right(regexp_replace(COALESCE(pan_no, ''), '[^A-Za-z0-9]', '', 'g'), 4)) AS pan4,
              right(regexp_replace(COALESCE(phoneno, ''), '\\D', '', 'g'), 10) AS phone10,
              COALESCE(isactive, 'Y') AS isactive
         FROM member_master WHERE mbno = $1`,
      [mbno],
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      mbno: r.mbno,
      fullName: r.full_name || '',
      dob: r.dob || null,
      panLast4: r.pan4 && r.pan4.length === 4 ? r.pan4 : null,
      phone10: r.phone10 || null,
      isActive: String(r.isactive).trim().toUpperCase() !== 'N',
    };
  }

  /** Is the registered phone usable as proof of identity? Also returns how many members share it. */
  async phoneQuality(phone10: string | null): Promise<{ status: PhoneStatus; sharedCount: number }> {
    if (!phone10) return { status: 'MISSING', sharedCount: 0 };
    if (phone10.length < 10 || /^(\d)\1+$/.test(phone10)) return { status: 'INVALID', sharedCount: 0 };
    const rows: Array<{ n: string }> = await this.ds.query(
      `SELECT count(*)::text AS n FROM member_master
        WHERE right(regexp_replace(COALESCE(phoneno, ''), '\\D', '', 'g'), 10) = $1`,
      [phone10],
    );
    const n = Number(rows[0]?.n ?? 0);
    return { status: n > SHARED_PHONE_LIMIT ? 'SHARED' : 'OK', sharedCount: n };
  }
}
