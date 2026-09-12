import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Injectable()
export class JottingReportService {
  constructor(
    @InjectDataSource()
    private dataSource: DataSource,
  ) {}

  async getHeadMasters() {
    try {
      const query = `
        SELECT 
          code,
          head_name as "headName",
          headtype,
          parent_code as "parentCode"
        FROM headmaster 
        WHERE code IS NOT NULL 
        AND head_name IS NOT NULL
        ORDER BY head_name
      `;
      
      const result = await this.dataSource.query(query);
      console.log('[DEBUG] getHeadMasters result:', result.length, 'records');
      return result;
    } catch (error) {
      console.error('[ERROR] getHeadMasters failed:', error.message);
      throw new Error(`Failed to fetch head masters: ${error.message}`);
    }
  }

  async getWingList() {
    try {
      const query = `
        SELECT 
          wingno as "wingNo",
          wname as "wingName"
        FROM wingmast 
        WHERE winstate = 1 
        AND wname IS NOT NULL
        ORDER BY wname
      `;
      
      const result = await this.dataSource.query(query);
      console.log('[DEBUG] getWingList result:', result.length, 'records');
      return result.map((wing: any) => wing.wingName);
    } catch (error) {
      console.error('[ERROR] getWingList failed:', error.message);
      throw new Error(`Failed to fetch wings: ${error.message}`);
    }
  }

  async getOfficeList() {
    try {
      const query = `
        SELECT DISTINCT 
          officeno as "officeNo"
        FROM member_master 
        WHERE officeno IS NOT NULL 
        ORDER BY officeno
      `;
      
      const result = await this.dataSource.query(query);
      console.log('[DEBUG] getOfficeList result:', result.length, 'records');
      return result.map((office: any) => office.officeNo.toString());
    } catch (error) {
      console.error('[ERROR] getOfficeList failed:', error.message);
      throw new Error(`Failed to fetch offices: ${error.message}`);
    }
  }

  async getJottingReport(params: {
    headCode: string;
    asOnDate: string;
    wingName?: string;
    officeName?: string;
    sortBy?: string;
  }) {
    try {
      const { headCode, asOnDate, wingName, officeName, sortBy = 'MBNO' } = params;
      
      console.log('[DEBUG] getJottingReport params:', params);
      
      let whereClause = `
        WHERE mm.isactive = '1'
        AND mm.mbno IS NOT NULL
      `;
      
      const queryParams: any[] = [headCode, asOnDate];
      let paramIndex = 3;
      
      if (wingName) {
        whereClause += ` AND wm.wname = $` + paramIndex;
        queryParams.push(wingName);
        paramIndex++;
      }
      
      if (officeName) {
        whereClause += ` AND mm.officeno::text = $` + paramIndex;
        queryParams.push(officeName);
        paramIndex++;
      }
      
      const orderClause = sortBy === 'Name' ? 'ORDER BY "memberName"' : 'ORDER BY mm.mbno';
      
      const query = `
        SELECT 
          mm.mbno as "memberNo",
          TRIM(CONCAT(
            COALESCE(mm.prefix, ''), ' ',
            COALESCE(mm.f_name, ''), ' ',
            COALESCE(mm.m_name, ''), ' ',
            COALESCE(mm.l_name, '')
          )) as "memberName",
          COALESCE(wm.wname, 'Unknown') as "wing",
          COALESCE(mm.officeno::text, 'Unknown') as "office",
          COALESCE(
            (SELECT SUM(
              CASE 
                WHEN l.trans_type = 'CR' THEN l.trans_amt::numeric
                WHEN l.trans_type = 'DR' THEN -l.trans_amt::numeric
                ELSE 0
              END
            ) 
            FROM ledger l 
            WHERE l.mbno = mm.mbno 
            AND l.code = $1
            AND l.trans_date <= $2::date), 0
          ) as "balance"
        FROM member_master mm
        LEFT JOIN wingmast wm ON mm.wingno = wm.wingno
        ${whereClause}
        ${orderClause}
      `;
      
      console.log('[DEBUG] getJottingReport query:', query);
      console.log('[DEBUG] getJottingReport queryParams:', queryParams);
      
      const result = await this.dataSource.query(query, queryParams);
      console.log('[DEBUG] getJottingReport result:', result.length, 'records');
      
      return result;
    } catch (error) {
      console.error('[ERROR] getJottingReport failed:', error.message);
      throw new Error(`Failed to generate jotting report: ${error.message}`);
    }
  }
}
