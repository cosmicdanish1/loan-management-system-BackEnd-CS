import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MemberLookupResponseDto } from '../dto/member-lookup.dto';

/**
 * Member Lookup Service - Handles member search and lookup operations.
 * 
 * @version 2.0 - Part of backend restructuring
 * Extracted from member.service.ts for single responsibility
 */
@Injectable()
export class MemberLookupService {
    constructor(private readonly dataSource: DataSource) { }

    /**
     * Lookup members for loan application and other forms
     */
    async lookupMembers(search?: string, limit?: number, offset?: number): Promise<MemberLookupResponseDto[]> {
        try {
            console.log('[MemberLookup] Looking up members with search:', search, 'limit:', limit, 'offset:', offset);

            // Set defaults and limits
            const actualLimit = Math.min(limit || 500, 1000); // Default 500, max 1000
            const actualOffset = offset || 0;

            const query = `
        SELECT DISTINCT
          m.mbno as memberNo,
          TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as memberName,
          m.officeno as officeNo,
          m.wingno as wingNo,
          COALESCE(d.name, 'Unknown Office') as officeName
        FROM member_master m
        LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
        WHERE (m.isactive = 'Y' OR m.isactive = '1') AND m.mbno IS NOT NULL
        ${search ? `AND (TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) ILIKE '%${search}%' OR m.mbno::text ILIKE '%${search}%')` : ''}
        ORDER BY TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, ''))
        LIMIT ${actualLimit} OFFSET ${actualOffset}
      `;

            console.log('[MemberLookup] Executing query with limit:', actualLimit, 'offset:', actualOffset);
            const result = await this.dataSource.query(query);
            console.log('[MemberLookup] Query result count:', result.length);

            const mappedResult = result.map((member: any) => ({
                memberNo: member.memberno,
                memberName: member.membername,
                officeNo: member.officeno,
                wingNo: member.wingno,
                officeName: member.officename
            }));

            console.log('[MemberLookup] Mapped result count:', mappedResult.length);
            return mappedResult;
        } catch (error) {
            console.error('[MemberLookup] Error in lookupMembers:', error);
            return [];
        }
    }

    /**
     * Get member details by member number
     */
    async getMemberDetailsByNumber(memberNo: string) {
        try {
            const query = `
        SELECT
          m.mbno,
          TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as fullname,
          m.f_name,
          m.m_name,
          m.l_name,
          m.officeno,
          m.wingno,
          m.pfno,
          m.desig,
          m.present_address,
          m.permanent_address,
          m.age,
          m.dob,
          m.dor,
          m.gross_salary,
          m.basic_pay,
          m.nominee_name,
          m.nominee_address,
          m.nominee_relation,
          m.declare_date,
          m.memb_date,
          m.flg_insured,
          m.insureamt,
          m.remarks,
          m.dept_name,
          m.isactive,
          m.flg_retire,
          COALESCE(d.name, 'Unknown Office') as office_name
        FROM member_master m
        LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
        WHERE m.mbno = $1
      `;

            const result = await this.dataSource.query(query, [memberNo]);
            return result[0] || null;
        } catch (error) {
            console.error('[MemberLookup] Error getting member details:', error);
            throw error;
        }
    }

    /**
     * Find member by member number (for verification)
     */
    async findByMemberNumber(memberNo: string) {
        try {
            const query = `
        SELECT
          m.mbno as memberNo,
          TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as memberName,
          m.isactive as status,
          m.officeno as officeNo,
          COALESCE(d.name, 'Unknown Office') as officeName
        FROM member_master m
        LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
        WHERE m.mbno = $1
      `;

            const result = await this.dataSource.query(query, [memberNo]);
            return result[0] || null;
        } catch (error) {
            console.error('[MemberLookup] Error finding member:', error);
            return null;
        }
    }
}
