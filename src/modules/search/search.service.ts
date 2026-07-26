import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface SearchResult {
  id: string;
  type: 'member' | 'account' | 'transaction' | 'loan';
  title: string;
  subtitle: string;
  details: string;
  date?: string;
  relevance?: number;
  // Structured fields consumed by the Find grid (MB No / Name / Wing / Division / A/C No / SR No)
  memberNo?: string;
  name?: string;
  wing?: string;
  division?: string;
  accountNo?: string;
  srNo?: string;
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    @InjectDataSource()
    private dataSource: DataSource,
  ) {
    this.logger.log('SearchService initialized with DataSource');
  }

  /**
   * Global search using only member_master table for now
   */
  async globalSearch(query: string, type: string = 'all', limit: number = 50): Promise<SearchResult[]> {
    try {
      this.logger.debug(`Global search: query="${query}", type=${type}, limit=${limit}`);

      const results: SearchResult[] = [];
      const searchTerm = `%${query.toLowerCase()}%`;

      if (type === 'all' || type === 'member') {
        const memberResults = await this.searchMembers(searchTerm, limit);
        results.push(...memberResults);
      }
      if (type === 'all' || type === 'account') {
        const accountResults = await this.searchAccounts(searchTerm, limit);
        results.push(...accountResults);
      }
      if (type === 'all' || type === 'transaction') {
        const txnResults = await this.searchTransactions(searchTerm, limit);
        results.push(...txnResults);
      }
      if (type === 'all' || type === 'loan') {
        const loanResults = await this.searchLoans(searchTerm, limit);
        results.push(...loanResults);
      }

      // Sort by relevance and limit results
      const sortedResults = results
        .sort((a, b) => (b.relevance || 0) - (a.relevance || 0))
        .slice(0, limit);

      this.logger.debug(`Found ${sortedResults.length} total results`);
      
      return sortedResults;

    } catch (error) {
      this.logger.error(`Error in global search: ${error.message}`, error.stack);
      return [];
    }
  }

  /**
   * Search using only member_master table - creates different result types based on search type
   */
  private async searchMembersOnly(searchTerm: string, type: string, limit: number): Promise<SearchResult[]> {
    try {
      this.logger.debug(`searchMembersOnly called with type: ${type}`);
      
      const query = `
        SELECT 
          m.mbno,
          m.f_name,
          m.m_name,
          m.l_name,
          m.basic_pay,
          m.memb_date,
          m.dob,
          m.desig,
          m.dept_name,
          m.officeno,
          m.isactive,
          d.name as office_name
        FROM member_master m
        LEFT JOIN division_master d ON m.officeno = d.officeno
        WHERE (
          LOWER(m.f_name || ' ' || COALESCE(m.m_name, '') || ' ' || m.l_name) LIKE $1
          OR m.mbno::text LIKE $1
          OR LOWER(COALESCE(d.name, '')) LIKE $1
          OR LOWER(COALESCE(m.desig, '')) LIKE $1
          OR LOWER(COALESCE(m.dept_name, '')) LIKE $1
        )
        AND m.mbno IS NOT NULL
        ORDER BY 
          CASE 
            WHEN m.mbno::text = TRIM($1, '%') THEN 1
            WHEN LOWER(m.f_name) LIKE $1 THEN 2
            ELSE 3
          END,
          m.mbno DESC
        LIMIT $2
      `;

      this.logger.debug(`Executing query with searchTerm=${searchTerm}, limit=${limit}`);
      
      const members = await this.dataSource.query(query, [searchTerm, limit]);
      
      this.logger.debug(`Raw query returned ${members.length} members`);

      const results: SearchResult[] = [];

      // Create different result types based on search type filter
      members.forEach((member: any, index: number) => {
        const fullName = `${member.f_name} ${member.m_name || ''} ${member.l_name}`.trim();
        const memberNo = member.mbno?.toString() || '';
        const office = member.office_name || 'Unknown Office';
        const basicPay = parseFloat(member.basic_pay) || 0;

        // Always add as member if type is 'all' or 'member'
        if (type === 'all' || type === 'member') {
          results.push({
            id: `member-${memberNo}`,
            type: 'member' as const,
            title: fullName,
            subtitle: `Member No: ${memberNo}`,
            details: `${office} - ${member.desig || 'No designation'} - Basic Pay: ₹${basicPay.toLocaleString()}`,
            date: member.memb_date ? new Date(member.memb_date).toLocaleDateString('en-GB') : undefined,
            relevance: this.calculateRelevance(searchTerm, fullName + ' ' + memberNo) + (index === 0 ? 10 : 0)
          });
        }

        // Add as account if type is 'all' or 'account'
        if (type === 'all' || type === 'account') {
          const accountBalance = basicPay * 10; // Simulate account balance
          results.push({
            id: `account-${memberNo}`,
            type: 'account' as const,
            title: `Savings Account - ${memberNo}`,
            subtitle: `Balance: ₹${accountBalance.toLocaleString()}`,
            details: `${fullName} - ${office} - ${member.isactive === 'Y' ? 'Active' : 'Inactive'}`,
            date: undefined,
            relevance: this.calculateRelevance(searchTerm, memberNo + ' account') + (index === 0 ? 5 : 0)
          });
        }

        // Add as transaction if type is 'all' or 'transaction'
        if (type === 'all' || type === 'transaction') {
          const transactionAmount = Math.floor(basicPay * 0.1) || 1000; // Simulate transaction
          results.push({
            id: `transaction-${memberNo}-${index}`,
            type: 'transaction' as const,
            title: `Recent Transaction`,
            subtitle: `Amount: ₹${transactionAmount.toLocaleString()}`,
            details: `${fullName} - ${office} - Deposit/Withdrawal`,
            date: new Date().toLocaleDateString('en-GB'),
            relevance: this.calculateRelevance(searchTerm, fullName + ' transaction')
          });
        }

        // Add as loan if type is 'all' or 'loan'
        if (type === 'all' || type === 'loan') {
          const loanAmount = Math.floor(basicPay * 5) || 50000; // Simulate loan
          const loanBalance = Math.floor(loanAmount * 0.7); // Simulate remaining balance
          results.push({
            id: `loan-${memberNo}-${index}`,
            type: 'loan' as const,
            title: `Loan Case ${memberNo}${String(index + 1).padStart(2, '0')}`,
            subtitle: `Amount: ₹${loanAmount.toLocaleString()} | Balance: ₹${loanBalance.toLocaleString()}`,
            details: `${fullName} - ${office} - Personal Loan`,
            date: member.memb_date ? new Date(member.memb_date).toLocaleDateString('en-GB') : undefined,
            relevance: this.calculateRelevance(searchTerm, fullName + ' loan')
          });
        }
      });

      this.logger.debug(`Generated ${results.length} results from ${members.length} members`);

      return results;

    } catch (error) {
      this.logger.error(`Error in searchMembersOnly: ${error.message}`, error.stack);
      return [];
    }
  }

  /**
   * Legacy search members function (kept for compatibility)
   */
  private async searchMembers(searchTerm: string, limit: number): Promise<SearchResult[]> {
    try {
      const query = `
        SELECT
          m.mbno,
          m.f_name,
          m.m_name,
          m.l_name,
          m.basic_pay,
          m.memb_date,
          m.wingno,
          m.officeno,
          d.name as office_name,
          m.isactive
        FROM member_master m
        LEFT JOIN division_master d ON m.officeno = d.officeno
        WHERE (
          LOWER(m.f_name || ' ' || COALESCE(m.m_name, '') || ' ' || m.l_name) LIKE $1
          OR m.mbno::text LIKE $1
          OR LOWER(d.name) LIKE $1
        )
        AND m.mbno IS NOT NULL
        ORDER BY
          CASE
            WHEN m.mbno::text = TRIM($1, '%') THEN 1
            WHEN LOWER(m.f_name) LIKE $1 THEN 2
            ELSE 3
          END,
          m.mbno DESC
        LIMIT $2
      `;

      const members = await this.dataSource.query(query, [searchTerm, limit]);

      return members.map((member: any) => {
        const fullName = `${member.f_name} ${member.m_name || ''} ${member.l_name}`.trim();
        const memberNo = member.mbno?.toString() || '';
        return {
          id: `member-${member.mbno}`,
          type: 'member' as const,
          title: fullName,
          subtitle: `Member No: ${memberNo}`,
          details: `${member.office_name || 'Unknown Office'} - Basic Pay: ₹${member.basic_pay || 0}`,
          date: member.memb_date ? new Date(member.memb_date).toLocaleDateString('en-GB') : undefined,
          relevance: this.calculateRelevance(searchTerm, member.f_name + ' ' + member.l_name + ' ' + member.mbno),
          // Structured fields for the Find grid
          memberNo,
          name: fullName,
          wing: member.wingno != null ? member.wingno.toString() : undefined,
          division: member.officeno != null ? member.officeno.toString() : undefined,
        };
      });

    } catch (error) {
      this.logger.error(`Error searching members: ${error.message}`);
      return [];
    }
  }

  /**
   * Search SB and FD accounts from sbmaster and fdmaster tables
   */
  private async searchAccounts(searchTerm: string, limit: number): Promise<SearchResult[]> {
    try {
      const results: SearchResult[] = [];

      // Search SB accounts
      try {
        const sbRows = await this.dataSource.query(`
          SELECT sb.acc_no, sb.mbno, sb.balance, m.f_name, m.l_name, m.wingno, m.officeno
          FROM sbmaster sb
          LEFT JOIN member_master m ON sb.mbno = m.mbno
          WHERE sb.acc_no::text LIKE $1 OR sb.mbno::text LIKE $1
             OR LOWER(COALESCE(m.f_name,'') || ' ' || COALESCE(m.l_name,'')) LIKE $1
          ORDER BY sb.acc_no DESC LIMIT $2
        `, [searchTerm, limit]);

        sbRows.forEach((row: any) => {
          const name = `${row.f_name || ''} ${row.l_name || ''}`.trim();
          results.push({
            id: `account-sb-${row.acc_no}`,
            type: 'account',
            title: `SB Account - ${row.acc_no}`,
            subtitle: `Balance: ₹${parseFloat(row.balance || 0).toLocaleString()}`,
            details: name || `Member ${row.mbno}`,
            relevance: this.calculateRelevance(searchTerm, row.acc_no + ' ' + name),
            memberNo: row.mbno?.toString(),
            name: name || undefined,
            accountNo: row.acc_no?.toString(),
            wing: row.wingno != null ? row.wingno.toString() : undefined,
            division: row.officeno != null ? row.officeno.toString() : undefined,
          });
        });
      } catch { /* sbmaster may not exist */ }

      // Search FD accounts
      try {
        const fdRows = await this.dataSource.query(`
          SELECT fd.fdno, fd.mbno, fd.fdamt, fd.matdate, m.f_name, m.l_name, m.wingno, m.officeno
          FROM fdmaster fd
          LEFT JOIN member_master m ON fd.mbno = m.mbno
          WHERE fd.fdno::text LIKE $1 OR fd.mbno::text LIKE $1
             OR LOWER(COALESCE(m.f_name,'') || ' ' || COALESCE(m.l_name,'')) LIKE $1
          ORDER BY fd.fdno DESC LIMIT $2
        `, [searchTerm, limit]);

        fdRows.forEach((row: any) => {
          const name = `${row.f_name || ''} ${row.l_name || ''}`.trim();
          results.push({
            id: `account-fd-${row.fdno}`,
            type: 'account',
            title: `FD Account - ${row.fdno}`,
            subtitle: `Amount: ₹${parseFloat(row.fdamt || 0).toLocaleString()}`,
            details: `${name} | Maturity: ${row.matdate ? new Date(row.matdate).toLocaleDateString('en-GB') : 'N/A'}`,
            relevance: this.calculateRelevance(searchTerm, row.fdno + ' ' + name),
            memberNo: row.mbno?.toString(),
            name: name || undefined,
            accountNo: row.fdno?.toString(),
            wing: row.wingno != null ? row.wingno.toString() : undefined,
            division: row.officeno != null ? row.officeno.toString() : undefined,
          });
        });
      } catch { /* fdmaster may not exist */ }

      return results;
    } catch (error) {
      this.logger.error(`Error searching accounts: ${error.message}`);
      return [];
    }
  }

  /**
   * Search transactions (using loan data as transaction proxy)
   */
  private async searchTransactions(searchTerm: string, limit: number): Promise<SearchResult[]> {
    try {
      const query = `
        SELECT 
          lm.loancaseno,
          lm.mbno,
          lm.loan_amt,
          lm.payment_date,
          lm.loantype,
          lm.purpose,
          m.f_name,
          m.l_name
        FROM loan_master lm
        LEFT JOIN member_master m ON lm.mbno = m.mbno
        WHERE (
          lm.mbno::text LIKE $1
          OR lm.loancaseno::text LIKE $1
          OR LOWER(lm.purpose) LIKE $1
          OR LOWER(m.f_name || ' ' || COALESCE(m.l_name, '')) LIKE $1
        )
        AND lm.loancaseno IS NOT NULL
        ORDER BY lm.payment_date DESC
        LIMIT $2
      `;

      const transactions = await this.dataSource.query(query, [searchTerm, limit]);

      return transactions.map((txn: any) => ({
        id: `transaction-${txn.loancaseno}`,
        type: 'transaction' as const,
        title: `${txn.loantype || 'Loan'} Transaction`,
        subtitle: `Amount: ₹${parseFloat(txn.loan_amt || 0).toLocaleString()}`,
        details: `${txn.f_name || ''} ${txn.l_name || ''}`.trim() + ` - ${txn.purpose || 'Loan Payment'}`,
        date: txn.payment_date ? new Date(txn.payment_date).toLocaleDateString('en-GB') : undefined,
        relevance: this.calculateRelevance(searchTerm, txn.loancaseno + ' ' + txn.purpose)
      }));

    } catch (error) {
      this.logger.error(`Error searching transactions: ${error.message}`);
      return [];
    }
  }

  /**
   * Search loans by case number, member, or purpose
   */
  private async searchLoans(searchTerm: string, limit: number): Promise<SearchResult[]> {
    try {
      const query = `
        SELECT 
          lm.loancaseno,
          lm.mbno,
          lm.loan_amt,
          lm.balance,
          lm.payment_date,
          lm.loantype,
          lm.purpose,
          m.f_name,
          m.l_name
        FROM loan_master lm
        LEFT JOIN member_master m ON lm.mbno = m.mbno
        WHERE (
          lm.loancaseno::text LIKE $1
          OR lm.mbno::text LIKE $1
          OR LOWER(lm.purpose) LIKE $1
          OR LOWER(m.f_name || ' ' || COALESCE(m.l_name, '')) LIKE $1
        )
        AND lm.loancaseno IS NOT NULL
        ORDER BY lm.payment_date DESC
        LIMIT $2
      `;

      const loans = await this.dataSource.query(query, [searchTerm, limit]);

      return loans.map((loan: any) => ({
        id: `loan-${loan.loancaseno}`,
        type: 'loan' as const,
        title: `Loan Case ${loan.loancaseno}`,
        subtitle: `Amount: ₹${parseFloat(loan.loan_amt || 0).toLocaleString()} | Balance: ₹${parseFloat(loan.balance || 0).toLocaleString()}`,
        details: `${loan.f_name || ''} ${loan.l_name || ''}`.trim() + ` - ${loan.loantype || 'Unknown'} - ${loan.purpose || 'No purpose'}`,
        date: loan.payment_date ? new Date(loan.payment_date).toLocaleDateString('en-GB') : undefined,
        relevance: this.calculateRelevance(searchTerm, loan.loancaseno + ' ' + loan.purpose)
      }));

    } catch (error) {
      this.logger.error(`Error searching loans: ${error.message}`);
      return [];
    }
  }

  /**
   * Calculate relevance score for search results
   */
  private calculateRelevance(searchTerm: string, text: string): number {
    const cleanSearchTerm = searchTerm.replace(/%/g, '').toLowerCase();
    const cleanText = text.toLowerCase();

    // Exact match gets highest score
    if (cleanText === cleanSearchTerm) return 100;
    
    // Starts with search term gets high score
    if (cleanText.startsWith(cleanSearchTerm)) return 90;
    
    // Contains search term gets medium score
    if (cleanText.includes(cleanSearchTerm)) return 70;
    
    // Partial word matches get lower score
    const words = cleanSearchTerm.split(' ');
    let wordMatches = 0;
    words.forEach(word => {
      if (cleanText.includes(word)) wordMatches++;
    });
    
    return (wordMatches / words.length) * 50;
  }

  /**
   * Get search suggestions based on query using member_master table
   */
  async getSearchSuggestions(query: string, limit: number = 5): Promise<string[]> {
    try {
      this.logger.debug(`Getting suggestions for: "${query}"`);

      if (query.length < 2) {
        return [];
      }

      const searchTerm = `%${query.toLowerCase()}%`;
      
      // Get member name and member number suggestions (fixed PostgreSQL DISTINCT issue)
      const suggestionQuery = `
        SELECT DISTINCT 
          CASE 
            WHEN m.mbno::text LIKE $1 THEN m.mbno::text
            ELSE m.f_name || ' ' || COALESCE(m.m_name, '') || ' ' || m.l_name
          END as suggestion,
          CASE 
            WHEN m.mbno::text LIKE $1 THEN 1
            ELSE 2
          END as sort_order
        FROM member_master m
        WHERE (
          LOWER(m.f_name || ' ' || COALESCE(m.m_name, '') || ' ' || m.l_name) LIKE $1
          OR m.mbno::text LIKE $1
        )
        AND m.mbno IS NOT NULL
        ORDER BY sort_order, suggestion
        LIMIT $2
      `;

      this.logger.debug(`Executing suggestions query with limit: ${limit}`);
      
      const memberSuggestions = await this.dataSource.query(suggestionQuery, [searchTerm, limit]);
      
      this.logger.debug(`Raw query returned ${memberSuggestions.length} suggestions`);
      
      const suggestions = memberSuggestions
        .map((s: any) => s.suggestion?.trim())
        .filter((s: string) => s && s.length > 0);

      this.logger.debug(`Returning ${suggestions.length} filtered suggestions`);
      
      return suggestions;

    } catch (error) {
      this.logger.error(`Error getting search suggestions: ${error.message}`, error.stack);
      return [];
    }
  }
}