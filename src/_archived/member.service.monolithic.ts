import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, FindOptionsWhere, ILike } from 'typeorm';
import { Member } from './entities/member.entity';
import { MemberMaster } from './entities/member-master.entity';
import {
  CreateMemberDto,
  UpdateMemberDto,
  MemberResponseDto,
  SearchMemberDto,
} from './dto';
import { MemberLookupResponseDto } from './dto/member-lookup.dto';
import { MemberNumberUtil, MemberValidationUtil } from './utils';
import { SequenceGeneratorService } from '../shared/services/sequence-generator.service';

@Injectable()
export class MemberService {
  private readonly logger = new Logger(MemberService.name);

  constructor(
    @InjectRepository(Member)
    private readonly memberRepository: Repository<Member>,
    @InjectRepository(MemberMaster)
    private readonly memberMasterRepository: Repository<MemberMaster>,
    private readonly sequenceGenerator: SequenceGeneratorService,
  ) { }

  /**
   * Create a new member
   */
  async create(createMemberDto: CreateMemberDto): Promise<MemberResponseDto> {
    // Validate member data
    const validation = MemberValidationUtil.validateMemberData(createMemberDto);
    if (!validation.isValid) {
      throw new BadRequestException(validation.errors);
    }

    // Check for duplicate phone number
    const existingMemberByPhone = await this.memberRepository.findOne({
      where: { phoneNumber: createMemberDto.phoneNumber },
    });
    if (existingMemberByPhone) {
      throw new ConflictException('Member with this phone number already exists');
    }

    // Check for duplicate email if provided
    if (createMemberDto.email) {
      const existingMemberByEmail = await this.memberRepository.findOne({
        where: { email: createMemberDto.email },
      });
      if (existingMemberByEmail) {
        throw new ConflictException('Member with this email already exists');
      }
    }

    // Check for duplicate Aadhar if provided
    if (createMemberDto.aadharNumber) {
      const existingMemberByAadhar = await this.memberRepository.findOne({
        where: { aadharNumber: createMemberDto.aadharNumber },
      });
      if (existingMemberByAadhar) {
        throw new ConflictException('Member with this Aadhar number already exists');
      }
    }

    // Check for duplicate PAN if provided
    if (createMemberDto.panNumber) {
      const existingMemberByPAN = await this.memberRepository.findOne({
        where: { panNumber: createMemberDto.panNumber },
      });
      if (existingMemberByPAN) {
        throw new ConflictException('Member with this PAN number already exists');
      }
    }

    // Generate member number
    const lastMember = await this.memberRepository.findOne({
      order: { id: 'DESC' },
    });
    const nextSequence = lastMember ? lastMember.id + 1 : 1;
    const memberNumber = MemberNumberUtil.generateMemberNumber(nextSequence);

    // Format phone number
    const formattedPhoneNumber = MemberValidationUtil.formatPhoneNumber(
      createMemberDto.phoneNumber,
    );

    // Create member entity
    const member = this.memberRepository.create({
      ...createMemberDto,
      memberNumber,
      phoneNumber: formattedPhoneNumber,
      dateOfBirth: new Date(createMemberDto.dateOfBirth),
      shareAmount: createMemberDto.shareAmount || 0,
      status: 'ACTIVE',
    });

    const savedMember = await this.memberRepository.save(member);
    return new MemberResponseDto(savedMember);
  }

  /**
   * Find all members with search and pagination
   */
  async findAll(searchDto: SearchMemberDto) {
    const {
      page = 1,
      limit = 10,
      search,
      memberNumber,
      firstName,
      lastName,
      phoneNumber,
      email,
      status,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = searchDto;

    const queryBuilder = this.memberRepository.createQueryBuilder('member');

    // Apply filters
    if (search) {
      queryBuilder.andWhere(
        '(member.memberNumber ILIKE :search OR member.firstName ILIKE :search OR member.lastName ILIKE :search OR member.phoneNumber ILIKE :search OR member.email ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    if (memberNumber) {
      queryBuilder.andWhere('member.memberNumber ILIKE :memberNumber', {
        memberNumber: `%${memberNumber}%`,
      });
    }

    if (firstName) {
      queryBuilder.andWhere('member.firstName ILIKE :firstName', {
        firstName: `%${firstName}%`,
      });
    }

    if (lastName) {
      queryBuilder.andWhere('member.lastName ILIKE :lastName', {
        lastName: `%${lastName}%`,
      });
    }

    if (phoneNumber) {
      queryBuilder.andWhere('member.phoneNumber ILIKE :phoneNumber', {
        phoneNumber: `%${phoneNumber}%`,
      });
    }

    if (email) {
      queryBuilder.andWhere('member.email ILIKE :email', {
        email: `%${email}%`,
      });
    }

    if (status) {
      queryBuilder.andWhere('member.status = :status', { status });
    }

    // Apply sorting
    queryBuilder.orderBy(`member.${sortBy}`, sortOrder);

    // Apply pagination
    const skip = (page - 1) * limit;
    queryBuilder.skip(skip).take(limit);

    const [members, total] = await queryBuilder.getManyAndCount();

    return {
      data: members.map(member => new MemberResponseDto(member)),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get member statistics
   */
  async getStatistics() {
    const totalMembers = await this.memberRepository.count();
    const activeMembers = await this.memberRepository.count({
      where: { status: 'ACTIVE' },
    });
    const inactiveMembers = await this.memberRepository.count({
      where: { status: 'INACTIVE' },
    });
    const suspendedMembers = await this.memberRepository.count({
      where: { status: 'SUSPENDED' },
    });

    return {
      totalMembers,
      activeMembers,
      inactiveMembers,
      suspendedMembers,
    };
  }

  /**
   * Find member by ID
   */
  async findOne(id: number): Promise<MemberResponseDto> {
    const member = await this.memberRepository.findOne({
      where: { id },
    });

    if (!member) {
      throw new NotFoundException(`Member with ID ${id} not found`);
    }

    return new MemberResponseDto(member);
  }

  /**
   * Update member
   */
  async update(id: number, updateMemberDto: UpdateMemberDto): Promise<MemberResponseDto> {
    const member = await this.memberRepository.findOne({
      where: { id },
    });

    if (!member) {
      throw new NotFoundException(`Member with ID ${id} not found`);
    }

    // Validate updated data
    const validation = MemberValidationUtil.validateMemberData(updateMemberDto);
    if (!validation.isValid) {
      throw new BadRequestException(validation.errors);
    }

    // Check for duplicate phone number (excluding current member)
    if (updateMemberDto.phoneNumber && updateMemberDto.phoneNumber !== member.phoneNumber) {
      const existingMemberByPhone = await this.memberRepository.findOne({
        where: { phoneNumber: updateMemberDto.phoneNumber },
      });
      if (existingMemberByPhone && existingMemberByPhone.id !== id) {
        throw new ConflictException('Member with this phone number already exists');
      }
    }

    // Check for duplicate email (excluding current member)
    if (updateMemberDto.email && updateMemberDto.email !== member.email) {
      const existingMemberByEmail = await this.memberRepository.findOne({
        where: { email: updateMemberDto.email },
      });
      if (existingMemberByEmail && existingMemberByEmail.id !== id) {
        throw new ConflictException('Member with this email already exists');
      }
    }

    // Format phone number if provided
    if (updateMemberDto.phoneNumber) {
      updateMemberDto.phoneNumber = MemberValidationUtil.formatPhoneNumber(
        updateMemberDto.phoneNumber,
      );
    }

    // Format date of birth if provided
    if (updateMemberDto.dateOfBirth) {
      updateMemberDto.dateOfBirth = new Date(updateMemberDto.dateOfBirth) as any;
    }

    // Update member
    Object.assign(member, updateMemberDto);
    const updatedMember = await this.memberRepository.save(member);

    return new MemberResponseDto(updatedMember);
  }

  /**
   * Delete member
   */
  async remove(id: number): Promise<void> {
    const member = await this.memberRepository.findOne({
      where: { id },
    });

    if (!member) {
      throw new NotFoundException(`Member with ID ${id} not found`);
    }

    await this.memberRepository.remove(member);
  }

  /**
   * Lookup members for loan application
   */
  async lookupMembers(search?: string, limit?: number, offset?: number): Promise<MemberLookupResponseDto[]> {
    try {
      // Set defaults and limits
      const actualLimit = Math.min(limit || 500, 1000); // Default 500, max 1000
      const actualOffset = offset || 0;

      const query = `
        SELECT DISTINCT
          m.mbno as memberNo,
          m.full_name as memberName,
          m.officeno as officeNo,
          m.wingno as wingNo,
          COALESCE(d.name, 'Unknown Office') as officeName
        FROM member_master m
        LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
        WHERE (m.isactive = 'Y' OR m.isactive = '1') AND m.mbno IS NOT NULL
        ${search ? `AND (m.full_name ILIKE '%${search}%' OR m.mbno::text ILIKE '%${search}%')` : ''}
        ORDER BY m.full_name
        LIMIT ${actualLimit} OFFSET ${actualOffset}
      `;

      this.logger.debug(`Executing query with limit: ${actualLimit}, offset: ${actualOffset}`);
      const result = await this.memberMasterRepository.query(query);
      this.logger.debug(`Query result count: ${result.length}`);

      const mappedResult = result.map((member: any) => ({
        memberNo: member.memberno,
        memberName: member.membername,
        officeNo: member.officeno,
        wingNo: member.wingno,
        officeName: member.officename
      }));

      this.logger.debug(`Mapped result count: ${mappedResult.length}`);
      return mappedResult;
    } catch (error) {
      this.logger.error(`Error in lookupMembers: ${error.message}`, error.stack);
      return [];
    }
  }

  /**
   * Get existing loan cases for a member
   */
  async getMemberLoanCases(memberNo: string) {
    try {
      const query = `
        SELECT 
          loancaseno,
          loantype,
          loan_amt::numeric as loan_amt,
          balance::numeric as balance,
          purpose
        FROM loan_master
        WHERE mbno = $1
        ORDER BY loancaseno DESC
      `;

      const loanCases = await this.memberMasterRepository.query(query, [memberNo]);

      this.logger.debug(`Found ${loanCases.length} loan cases for member ${memberNo}`);

      return loanCases.map((loan: any) => ({
        memberNo,
        loanCaseNo: loan.loancaseno,
        loanType: loan.loantype,
        loanAmount: loan.loan_amt,
        balance: loan.balance,
        purpose: loan.purpose
      }));
    } catch (error) {
      this.logger.error(`Error getting member loan cases for ${memberNo}: ${error.message}`);
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

      const result = await this.memberMasterRepository.query(query, [memberNo]);
      return result[0] || null;
    } catch (error) {
      this.logger.error(`Error getting member details for ${memberNo}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Save or update member master
   */
  async saveMemberMaster(memberData: any) {
    try {
      if (memberData.mbno && memberData.mbno !== 'auto') {
        // Update existing member
        const fullName = [memberData.f_name, memberData.m_name, memberData.l_name].filter(Boolean).join(' ').trim();
        const updateQuery = `
          UPDATE member_master SET
            prefix = $2, f_name = $3, m_name = $4, l_name = $5, sex = $6, desig = $7,
            present_address = $8, permanent_address = $9, wingno = $10, officeno = $11, age = $12,
            dob = $13, dor = $14, gross_salary = $15, basic_pay = $16, nominee_name = $17,
            nominee_address = $18, nominee_relation = $19, declare_date = $20, memb_date = $21,
            pfno = $22, flg_insured = $23, insureamt = $24, remarks = $25, dept_name = $26,
            isactive = $27, flg_retire = $28, full_name = $29
          WHERE mbno = $1
          RETURNING *
        `;

        const result = await this.memberMasterRepository.query(updateQuery, [
          memberData.mbno, memberData.prefix, memberData.f_name, memberData.m_name,
          memberData.l_name, memberData.sex, memberData.desig, memberData.present_address,
          memberData.permanent_address, memberData.wingno, memberData.officeno, memberData.age,
          memberData.dob, memberData.dor, memberData.gross_salary, memberData.basic_pay,
          memberData.nominee_name, memberData.nominee_address, memberData.nominee_relation,
          memberData.declare_date, memberData.memb_date, memberData.pfno, memberData.flg_insured,
          memberData.insureamt, memberData.remarks, memberData.dept_name, memberData.isactive,
          memberData.flg_retire, fullName
        ]);

        return { success: true, data: result[0] };
      } else {
        // Insert new member
        const memberNumber = await this.generateNextMemberNumber();
        const fullName = [memberData.f_name, memberData.m_name, memberData.l_name].filter(Boolean).join(' ').trim();

        const insertQuery = `
          INSERT INTO member_master (
            mbno, prefix, f_name, m_name, l_name, sex, desig,
            present_address, permanent_address, wingno, officeno, age,
            dob, dor, gross_salary, basic_pay, nominee_name, nominee_address,
            nominee_relation, declare_date, memb_date, pfno, lfno, flg_incometax,
            flg_insured, insureamt, remarks, dept_name, isactive, flg_retire, full_name
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
            $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
            $25, $26, $27, $28, $29, $30, $31
          )
          RETURNING *
        `;

        const result = await this.memberMasterRepository.query(insertQuery, [
          memberNumber, memberData.prefix, memberData.f_name, memberData.m_name,
          memberData.l_name, memberData.sex, memberData.desig, memberData.present_address,
          memberData.permanent_address, memberData.wingno, memberData.officeno, memberData.age,
          memberData.dob, memberData.dor, memberData.gross_salary, memberData.basic_pay,
          memberData.nominee_name, memberData.nominee_address, memberData.nominee_relation,
          memberData.declare_date, memberData.memb_date, memberData.pfno, memberData.lfno || '',
          memberData.flg_incometax || 'N', memberData.flg_insured, memberData.insureamt,
          memberData.remarks, memberData.dept_name, memberData.isactive,
          memberData.flg_retire, fullName
        ]);

        return { success: true, data: result[0] };
      }
    } catch (error) {
      console.error('Error saving member master:', error);
      throw error;
    }
  }

  /**
   * Generate next sequential member number (8 digits)
   */
  async generateNextMemberNumber(): Promise<string> {
    try {
      return await this.sequenceGenerator.generateNextMemberNumber();
    } catch (error) {
      this.logger.error('Error generating member number:', error);
      // Fallback in case of sequence generator failure
      const query = `SELECT MAX(mbno::bigint) as max_val FROM member_master WHERE mbno::text ~ '^[0-9]+$'`;
      const result = await this.memberMasterRepository.query(query);
      const val = result[0]?.max_val || 10000000;
      return (parseInt(val) + 1).toString().padStart(8, '0');
    }
  }

  /**
   * Get member balance information with comprehensive balance breakdown
   */
  async getMemberBalance(memberNo: string) {
    try {
      console.log(`[BALANCE] Getting comprehensive balance for member: ${memberNo}`);

      // Get comprehensive member and balance info in a single query
      const comprehensiveQuery = `
        SELECT
          m.mbno, 
          TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
          COALESCE(d.name, 'Unknown Office') as office_name,
          COALESCE(m.basic_pay, 0) as basic_pay,
          COALESCE(m.isactive, 'N') as is_active,
          -- Balance data from member_balances
          COALESCE(mb.shares, 0) as shares,
          COALESCE(mb.compulsory_deposit, 0) as compulsory_deposit,
          COALESCE(mb.rd_amt, 0) as rd_amount,
          COALESCE(mb.regularloan, 0) as regular_loan_balance,
          COALESCE(mb.emergency_loan_balance, 0) as emergency_loan_balance,
          COALESCE(mb.frsbalance, 0) as frs_balance
        FROM member_master m
        LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
        LEFT JOIN member_balances mb ON m.mbno = mb.mbno
        WHERE m.mbno = $1
      `;

      const result = await this.memberMasterRepository.query(comprehensiveQuery, [memberNo]);

      if (result.length === 0) {
        throw new Error('Member not found');
      }

      const member = result[0];

      // Get additional loan balances from loan_master if available
      let additionalLoanBalances = {};
      let totalLoanFromMaster = 0;

      try {
        const loanQuery = `
          SELECT
            COALESCE(loantype, 'UNKNOWN') as loantype,
            SUM(CASE 
              WHEN balance IS NOT NULL AND balance != '' 
              THEN balance::numeric
              ELSE 0
            END) as total_balance
          FROM loan_master
          WHERE mbno = $1 AND balance IS NOT NULL AND balance != ''
          GROUP BY loantype
        `;

        const loanResult = await this.memberMasterRepository.query(loanQuery, [memberNo]);

        loanResult.forEach((loan: any) => {
          const balance = parseFloat(loan.total_balance) || 0;
          if (balance > 0) {
            additionalLoanBalances[loan.loantype || 'UNKNOWN'] = balance;
            totalLoanFromMaster += balance;
          }
        });
      } catch (error) {
        console.log('⚠️ loan_master table query failed, using member_balances data only');
      }

      // Create comprehensive balance items
      const balanceItems = [];

      // Assets
      const shares = parseFloat(member.shares) || 0;
      if (shares > 0) {
        balanceItems.push({
          code: 'SH',
          headName: 'Share Amount',
          balance: shares,
          type: 'asset'
        });
      }

      const compulsoryDeposit = parseFloat(member.compulsory_deposit) || 0;
      if (compulsoryDeposit > 0) {
        balanceItems.push({
          code: 'CD',
          headName: 'Compulsory Deposit',
          balance: compulsoryDeposit,
          type: 'asset'
        });
      }

      const rdAmount = parseFloat(member.rd_amount) || 0;
      if (rdAmount > 0) {
        balanceItems.push({
          code: 'RD',
          headName: 'Recurring Deposit',
          balance: rdAmount,
          type: 'asset'
        });
      }

      const frsBalance = parseFloat(member.frs_balance) || 0;
      if (frsBalance > 0) {
        balanceItems.push({
          code: 'FRS',
          headName: 'FRS Balance',
          balance: frsBalance,
          type: 'asset'
        });
      }

      // Liabilities
      const regularLoan = parseFloat(member.regular_loan_balance) || 0;
      if (regularLoan > 0) {
        balanceItems.push({
          code: 'RLN',
          headName: 'Regular Loan',
          balance: -regularLoan, // Negative for liability
          type: 'liability'
        });
      }

      const emergencyLoan = parseFloat(member.emergency_loan_balance) || 0;
      if (emergencyLoan > 0) {
        balanceItems.push({
          code: 'ELN',
          headName: 'Emergency Loan',
          balance: -emergencyLoan, // Negative for liability
          type: 'liability'
        });
      }

      // Add additional loans from loan_master
      Object.entries(additionalLoanBalances).forEach(([loanType, balance]) => {
        if (parseFloat(balance as string) > 0) {
          balanceItems.push({
            code: loanType,
            headName: `${loanType} Loan`,
            balance: -parseFloat(balance as string), // Negative for liability
            type: 'liability'
          });
        }
      });

      // Calculate totals
      const totalAssets = balanceItems
        .filter(item => item.type === 'asset')
        .reduce((sum, item) => sum + item.balance, 0);

      const totalLiabilities = Math.abs(balanceItems
        .filter(item => item.type === 'liability')
        .reduce((sum, item) => sum + item.balance, 0));

      const netBalance = totalAssets - totalLiabilities;

      // Use loan_master total if available, otherwise use member_balances
      const finalLoanBalance = totalLoanFromMaster > 0 ? totalLoanFromMaster : (regularLoan + emergencyLoan);

      const balanceData = {
        memberInfo: {
          memberNo: member.mbno,
          memberName: member.member_name,
          officeName: member.office_name,
          basicPay: parseFloat(member.basic_pay) || 0,
          isActive: member.is_active === 'Y'
        },
        loans: {
          balances: Object.keys(additionalLoanBalances).length > 0 ? additionalLoanBalances : {
            RLN: regularLoan,
            ELN: emergencyLoan
          },
          totalBalance: finalLoanBalance
        },
        balanceItems: balanceItems,
        summary: {
          totalAssets: totalAssets,
          totalLiabilities: totalLiabilities,
          netBalance: netBalance
        }
      };

      console.log(`[BALANCE] Comprehensive balance calculated for member ${memberNo}:`, {
        memberName: member.member_name,
        totalAssets: totalAssets,
        totalLiabilities: totalLiabilities,
        netBalance: netBalance,
        balanceItemsCount: balanceItems.length
      });

      return balanceData;
    } catch (error) {
      console.error('Error getting member balance:', error);
      throw error;
    }
  }

  /**
   * Generate next sequential loan case number
   */
  async generateNextLoanCaseNo(): Promise<string> {
    try {
      const query = `
        SELECT MAX(CAST(loancaseno AS INTEGER)) as max_case_no
        FROM loan_pending
        WHERE loancaseno IS NOT NULL
      `;

      const result = await this.memberMasterRepository.query(query);
      const maxCaseNo = result[0]?.max_case_no || 10000;
      const nextCaseNo = (maxCaseNo + 1).toString();

      console.log(`Generated next loan case number: ${nextCaseNo}`);
      return nextCaseNo;
    } catch (error) {
      console.error('Error generating loan case number:', error);
      throw new Error('Failed to generate loan case number');
    }
  }

  /**
   * Save loan application
   */
  async saveLoanApplication(loanData: any) {
    try {
      console.log('Saving loan application:', loanData);

      // Map loan types to 3-character codes for database
      const loanTypeMapping = {
        'EMERGENCY': 'ELN',
        'REGULAR': 'RLN',
        'AGAINST': 'ALN',
        'EMERGENCY LOAN': 'ELN',
        'REGULAR LOAN': 'RLN',
        'LOAN AGAINST DEPOSIT': 'ALN',
        'Emergency': 'ELN',
        'Regular': 'RLN',
        'Against': 'ALN',
        'ELN': 'ELN',
        'RLN': 'RLN',
        'ALN': 'ALN'
      };

      const lookupKey = loanData.loanType ? loanData.loanType.toString() : '';
      const mappedLoanType = loanTypeMapping[lookupKey] ||
        loanTypeMapping[lookupKey.toUpperCase()] ||
        lookupKey.substring(0, 3).toUpperCase();

      // Generate loan case number if not provided
      let loanCaseNo = loanData.loanCaseNo;
      if (!loanCaseNo) {
        loanCaseNo = await this.generateNextLoanCaseNo();
      }

      const insertQuery = `
        INSERT INTO loan_pending (
          mbno, loantype, loancaseno, applied_amt, sanctioned_amt, app_date,
          no_of_instal, purpose, flg_sanctioned, flg_paid, form_number, g1mbno, g2mbno
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *
      `;

      const result = await this.memberMasterRepository.query(insertQuery, [
        loanData.memberNo,
        mappedLoanType, // Use mapped 3-character code
        loanCaseNo,
        loanData.loanAmount || loanData.appliedAmount,
        0, // sanctioned_amt = 0 initially (will be updated during sanction)
        new Date(),
        loanData.noOfInstallments || 60,
        loanData.reason || loanData.purpose || '',
        'N', // flg_sanctioned = 'N' (not sanctioned yet)
        'N', // flg_paid = 'N' (not paid yet)
        loanData.formNumber || '0',
        loanData.surety1 || '0',
        loanData.surety2 || '0'
      ]);

      console.log(`✅ Loan application saved successfully. Case No: ${loanCaseNo}`);

      return {
        success: true,
        message: 'Loan application saved successfully',
        loanCaseNo: loanCaseNo,
        data: result[0]
      };
    } catch (error) {
      console.error('❌ Error saving loan application:', error);
      throw new Error('Failed to save loan application: ' + error.message);
    }
  }

  /**
   * Get all loan cases for loan payment processing
   */
  async getAllLoanCases() {
    try {
      const query = `
        SELECT 
          lp.loancaseno,
          lp.mbno,
          TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.m_name, '') || ' ' || COALESCE(mm.l_name, '')) as member_name,
          lp.loantype,
          lp.applied_amt,
          lp.sanctioned_amt,
          lp.flg_sanctioned,
          lp.flg_paid,
          lp.app_date as application_date
        FROM loan_pending lp
        JOIN member_master mm ON lp.mbno = mm.mbno
        WHERE lp.flg_paid = 'N'
        ORDER BY lp.app_date DESC
      `;

      const result = await this.memberMasterRepository.query(query);

      return result.map((loan: any) => ({
        loanCaseNo: loan.loancaseno,
        memberNo: loan.mbno,
        memberName: loan.member_name,
        loanType: loan.loantype,
        appliedAmount: loan.applied_amt,
        sanctionedAmount: loan.sanctioned_amt,
        applicationDate: loan.application_date,
        sanctioned: loan.flg_sanctioned === 'Y'
      }));
    } catch (error) {
      console.error('Error getting loan cases:', error);
      return [];
    }
  }

  /**
   * Get all sanctioned loan cases ready for disbursement
   */
  async getSanctionedLoanCases() {
    try {
      const query = `
        SELECT 
          lp.loancaseno,
          lp.mbno,
          TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.m_name, '') || ' ' || COALESCE(mm.l_name, '')) as member_name,
          lp.loantype,
          lp.applied_amt,
          lp.sanctioned_amt,
          lp.flg_sanctioned,
          lp.flg_paid,
          lp.app_date as application_date
        FROM loan_pending lp
        JOIN member_master mm ON lp.mbno = mm.mbno
        WHERE lp.flg_sanctioned = 'Y' AND lp.flg_paid = 'N'
        ORDER BY lp.app_date ASC
      `;

      const result = await this.memberMasterRepository.query(query);

      return result.map((loan: any) => ({
        loanCaseNo: loan.loancaseno,
        memberNo: loan.mbno,
        memberName: loan.member_name,
        loanType: loan.loantype,
        appliedAmount: loan.applied_amt,
        sanctionedAmount: loan.sanctioned_amt,
        applicationDate: loan.application_date,
        sanctioned: true
      }));
    } catch (error) {
      console.error('Error getting sanctioned loan cases:', error);
      return [];
    }
  }

  /**
   * Get loan details by case number
   */
  async getLoanDetailsByCaseNo(caseNo: string) {
    try {
      const query = `
        SELECT 
          lp.*,
          TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.m_name, '') || ' ' || COALESCE(mm.l_name, '')) as member_name,
          mm.officeno,
          mm.basic_pay,
          COALESCE(d.name, 'Unknown Office') as office_name,
          COALESCE(mb.shares, 0) as share_amount,
          COALESCE(mb.regularloan, 0) as regular_loan_balance,
          COALESCE(mb.emergency_loan_balance, 0) as emergency_loan_balance,
          
          -- Derive Account Head Code & Name based on Loan Type
          CASE 
            WHEN lp.loantype = 'R' OR lp.loantype = 'REG' THEN 'A1002'
            WHEN lp.loantype = 'E' OR lp.loantype = 'EMR' THEN 'A1047'
            -- Add other types if known, e.g., 'M' -> 'Axxxx'
            ELSE 'A1047' -- Default to Emergency/General Loan if unknown
          END as h_code,
          
          CASE 
            WHEN lp.loantype = 'R' OR lp.loantype = 'REG' THEN 'REGULAR LOAN'
            WHEN lp.loantype = 'E' OR lp.loantype = 'EMR' THEN 'EMERGENCY LOAN'
            ELSE 'LOAN ACCOUNT'
          END as h_name,

          -- Surety 1 Details
          TRIM(COALESCE(s1.f_name, '') || ' ' || COALESCE(s1.m_name, '') || ' ' || COALESCE(s1.l_name, '')) as s1_name,
          COALESCE(s1_d.name, 'Unknown Office') as s1_office,
          (COALESCE(s1_mb.regularloan, 0) + COALESCE(s1_mb.emergency_loan_balance, 0)) as s1_loan_balance,

          -- Surety 2 Details
          TRIM(COALESCE(s2.f_name, '') || ' ' || COALESCE(s2.m_name, '') || ' ' || COALESCE(s2.l_name, '')) as s2_name,
          COALESCE(s2_d.name, 'Unknown Office') as s2_office,
          (COALESCE(s2_mb.regularloan, 0) + COALESCE(s2_mb.emergency_loan_balance, 0)) as s2_loan_balance

        FROM loan_pending lp
        JOIN member_master mm ON lp.mbno = mm.mbno
        LEFT JOIN division_master d ON mm.officeno = d.officeno AND mm.wingno = d.wingno
        LEFT JOIN member_balances mb ON lp.mbno = mb.mbno

        -- Join for Surety 1
        LEFT JOIN member_master s1 ON lp.g1mbno = s1.mbno
        LEFT JOIN division_master s1_d ON s1.officeno = s1_d.officeno AND s1.wingno = s1_d.wingno
        LEFT JOIN member_balances s1_mb ON s1.mbno = s1_mb.mbno

        -- Join for Surety 2
        LEFT JOIN member_master s2 ON lp.g2mbno = s2.mbno
        LEFT JOIN division_master s2_d ON s2.officeno = s2_d.officeno AND s2.wingno = s2_d.wingno
        LEFT JOIN member_balances s2_mb ON s2.mbno = s2_mb.mbno

        WHERE lp.loancaseno = $1
      `;

      const result = await this.memberMasterRepository.query(query, [caseNo]);

      if (result.length === 0) {
        return null;
      }

      const loan = result[0];
      console.log('DEBUG: Fetched Loan Details for Case:', caseNo, JSON.stringify(loan, null, 2));

      const response = {
        loanCaseNo: loan.loancaseno,
        memberNo: loan.mbno,
        memberName: loan.member_name,
        officeNo: loan.officeno,
        officeName: loan.office_name,
        loanType: loan.loantype,
        hCode: loan.h_code, // Mapped
        hName: loan.h_name, // Mapped
        appliedAmount: loan.applied_amt,
        sanctionedAmount: loan.sanctioned_amt,
        applicationDate: loan.app_date,
        sanctionDate: loan.sanctioned_date,
        noOfInstallments: loan.no_of_instal,
        purpose: loan.purpose,
        formNumber: loan.form_number || '0',
        basicPay: loan.basic_pay || '0',
        shareAmount: loan.share_amount || '0',
        currentBalance: (parseFloat(loan.regular_loan_balance || 0) + parseFloat(loan.emergency_loan_balance || 0)).toString(),

        surety1: loan.g1mbno || '0',
        surety1Name: loan.s1_name || '',
        surety1Office: loan.s1_office || '',
        surety1LoanBalance: loan.s1_loan_balance || '0',

        surety2: loan.g2mbno || '0',
        surety2Name: loan.s2_name || '',
        surety2Office: loan.s2_office || '',
        surety2LoanBalance: loan.s2_loan_balance || '0',

        surety3: loan.g3mbno || '0'
      };

      console.log('DEBUG: Final Mapped Response:', JSON.stringify(response, null, 2));
      return response;
    } catch (error) {
      console.error('Error getting loan details:', error);
      throw error;
    }
  }

  /**
   * Update loan with sanction details
   */
  async updateLoanSanction(caseNo: string, sanctionData: any) {
    try {
      const updateQuery = `
        UPDATE loan_pending SET
          sanctioned_amt = $1,
          sanctioned_date = $2,
          no_of_instal = $3,
          flg_sanctioned = 'Y'
        WHERE loancaseno::numeric = $4::numeric
        RETURNING *
      `;

      const result = await this.memberMasterRepository.query(updateQuery, [
        sanctionData.sanctionedAmount,
        sanctionData.sanctionDate || new Date(),
        sanctionData.noOfInstallments,
        caseNo
      ]);

      if (result.length === 0) {
        throw new Error('Loan case not found');
      }

      return {
        success: true,
        message: 'Loan sanctioned successfully',
        data: result[0]
      };
    } catch (error) {
      console.error('Error updating loan sanction:', error);
      throw new Error('Failed to update loan sanction: ' + error.message);
    }
  }

  /**
   * Generate voucher for loan disbursement (Step 3)
   * Uses existing vouchers table with sequential number
   */
  async generateLoanVoucher(voucherData: any) {
    const queryRunner = this.memberMasterRepository.manager.connection.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      console.log('🎯 Generating voucher for loan disbursement:', voucherData);

      // 1. Get and increment voucher number
      const voucherNumber = await this.getNextVoucherNumber();

      // 2. Validate loan case exists and is sanctioned
      const loanQuery = `
        SELECT loancaseno, mbno, sanctioned_amt, flg_sanctioned, flg_paid
        FROM loan_pending 
        WHERE loancaseno = $1 AND flg_sanctioned = 'Y' AND flg_paid = 'N'
      `;

      const loanResult = await queryRunner.query(loanQuery, [voucherData.loanCaseNo]);

      if (loanResult.length === 0) {
        throw new Error('Loan case not found or not sanctioned or already disbursed');
      }

      const loan = loanResult[0];

      // 3. Insert voucher to voucher_staging table
      const insertQuery = `
        INSERT INTO voucher_staging (
          "voucher_no", "loan_case_no", "amount", "payment_mode", 
          "bank_details", "cheque_no", "cheque_date", "narration", "is_posted", "created_at", "status"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
      `;

      const insertValues = [
        voucherNumber,
        voucherData.loanCaseNo,
        voucherData.actualAmount || loan.sanctioned_amt,
        voucherData.paymentMode,
        voucherData.bankName || null,
        voucherData.chequeNo || null,
        voucherData.chequeDate ? new Date(voucherData.chequeDate) : null,
        voucherData.narration || `Loan disbursement for case ${voucherData.loanCaseNo}`,
        false, // is_posted
        new Date(),
        'PENDING'
      ];

      const voucherResult = await queryRunner.query(insertQuery, insertValues);

      // 4. Insert Breakdown Details
      if (voucherData.breakdown && Array.isArray(voucherData.breakdown)) {
        for (const entry of voucherData.breakdown) {
          const detailQuery = `
            INSERT INTO voucher_staging_details (
              voucher_no, sr_no, code, name, type, amount
            ) VALUES ($1, $2, $3, $4, $5, $6)
          `;
          await queryRunner.query(detailQuery, [
            voucherNumber,
            parseInt(entry.srNo) || 0,
            entry.code,
            entry.name,
            entry.rp,
            entry.amount
          ]);
        }
      }

      await queryRunner.commitTransaction();
      console.log(`✅ Voucher ${voucherNumber} generated successfully with details`);

      return {
        success: true,
        message: 'Voucher generated successfully',
        voucherNo: voucherNumber,
        data: voucherResult[0]
      };

    } catch (error) {
      await queryRunner.rollbackTransaction();
      console.error('❌ Error generating voucher:', error);
      throw new Error('Failed to generate voucher: ' + error.message);
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get next sequential voucher number
   * Format: VCH001, VCH002, VCH003...
   * Uses existing voucher_master table for numbering
   */
  private async getNextVoucherNumber(): Promise<string> {
    try {
      // Get current max voucher number from both permanent and staging tables
      const getMaxQuery = `
        SELECT MAX(num) as max_num FROM (
          SELECT COALESCE(MAX(CAST(SUBSTRING("voucherNumber" FROM 4) AS INTEGER)), 0) as num
          FROM vouchers 
          WHERE "voucherNumber" LIKE 'VCH%'
          UNION ALL
          SELECT COALESCE(MAX(CAST(SUBSTRING(voucher_no FROM 4) AS INTEGER)), 0) as num
          FROM voucher_staging
          WHERE voucher_no LIKE 'VCH%'
        ) combined
      `;

      const maxResult = await this.memberMasterRepository.query(getMaxQuery);
      const currentMax = maxResult[0]?.max_num || 0;
      const nextNumber = currentMax + 1;

      // Format as VCH001, VCH002, etc. (using 3 digits padding as per current style)
      const voucherNumber = `VCH${nextNumber.toString().padStart(3, '0')}`;

      console.log(`📄 Generated safe voucher number: ${voucherNumber}`);
      return voucherNumber;

    } catch (error) {
      console.error('❌ Error generating voucher number:', error);
      throw new Error('Failed to generate voucher number: ' + error.message);
    }
  }

  /**
   * Get next sequential voucher ID
   */
  private async getNextVoucherId(): Promise<number> {
    try {
      const getMaxQuery = `
        SELECT COALESCE(MAX(id), 0) + 1 as next_id
        FROM vouchers
      `;

      const maxResult = await this.memberMasterRepository.query(getMaxQuery);
      const nextId = maxResult[0]?.next_id || 1;

      console.log(`🆔 Generated voucher ID: ${nextId}`);
      return nextId;

    } catch (error) {
      console.error('❌ Error generating voucher ID:', error);
      throw new Error('Failed to generate voucher ID: ' + error.message);
    }
  }

  /**
   * Get pending vouchers for Pass Transaction (Step 4)
   */
  async getPendingVouchers() {
    try {
      const query = `
        SELECT 
          vs.*,
          lp.loantype,
          TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.m_name, '') || ' ' || COALESCE(mm.l_name, '')) as member_name,
          mm.mbno
        FROM voucher_staging vs
        JOIN loan_pending lp ON vs.loan_case_no = lp.loancaseno::text
        JOIN member_master mm ON lp.mbno = mm.mbno
        WHERE vs.status = 'PENDING' AND vs.is_posted = FALSE
        ORDER BY vs.created_at DESC
      `;

      const result = await this.memberMasterRepository.query(query);

      // For each voucher, fetch its details
      const vouchersWithDetails = [];
      for (const row of result) {
        const detailsQuery = `SELECT * FROM voucher_staging_details WHERE voucher_no = $1 ORDER BY sr_no`;
        const details = await this.memberMasterRepository.query(detailsQuery, [row.voucher_no]);

        vouchersWithDetails.push({
          id: row.id,
          trNo: '', // Placeholder as it's not yet posted
          voucherNo: row.voucher_no,
          memberNo: row.mbno,
          memberName: row.member_name,
          noOfAcc: '1', // Default
          head: row.loantype,
          transType: 'Payment',
          amount: parseFloat(row.amount),
          vchrType: 'Loan Disbursement',
          chequeNo: row.cheque_no,
          chequeDate: row.cheque_date,
          chequeAmount: row.payment_mode === 'BANK' || row.payment_mode === 'bank' ? parseFloat(row.amount) : 0,
          bankName: row.bank_details,
          passFlag: row.status,
          narration: row.narration,
          loanCaseNo: row.loan_case_no,
          createdDate: row.created_at,
          breakdown: details.map((d: any) => ({
            srNo: d.sr_no.toString(),
            code: d.code,
            name: d.name,
            rp: d.type,
            amount: parseFloat(d.amount)
          }))
        });
      }

      return vouchersWithDetails;

    } catch (error) {
      console.error('❌ Error fetching pending vouchers:', error);
      throw new Error('Failed to fetch pending vouchers: ' + error.message);
    }
  }

  /**
   * Pass Transaction - Final Posting (Step 4)
   * Move voucher from staging to permanent ledger, activate loan, and update cashbook.
   */
  async passTransaction(voucherNo: string, postedBy: string = 'admin') {
    const queryRunner = this.memberMasterRepository.manager.connection.createQueryRunner();

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      console.log(`🔒 Starting Pass Transaction for voucher: ${voucherNo}`);

      // 1. Fetch voucher from staging
      const voucherQuery = `SELECT * FROM voucher_staging WHERE voucher_no = $1 AND status = 'PENDING'`;
      const voucherResult = await queryRunner.query(voucherQuery, [voucherNo]);
      if (voucherResult.length === 0) {
        throw new Error('Voucher not found or already posted');
      }
      const stagingVoucher = voucherResult[0];

      // 2. Fetch breakdown details
      const detailsQuery = `SELECT * FROM voucher_staging_details WHERE voucher_no = $1 ORDER BY sr_no`;
      const details = await queryRunner.query(detailsQuery, [voucherNo]);

      // 3. Fetch loan pending data
      const lpQuery = `SELECT * FROM loan_pending WHERE loancaseno::text = $1`;
      const lpResult = await queryRunner.query(lpQuery, [stagingVoucher.loan_case_no]);
      if (lpResult.length === 0) throw new Error('Loan case not found in loan_pending');
      const loan = lpResult[0];

      // 4. Fetch rates from busrules
      const brQuery = `SELECT rlnrate, rlnpenalrate, elnrate FROM busrules ORDER BY appdate DESC LIMIT 1`;
      const brResult = await queryRunner.query(brQuery);
      const br = brResult[0] || {};

      let rate = 12;
      let penalrate = 2;
      if (loan.loantype === 'R' || loan.loantype === 'REG') {
        rate = br.rlnrate || 12;
        penalrate = br.rlnpenalrate || 2;
      } else if (loan.loantype === 'E' || loan.loantype === 'EMR') {
        rate = br.elnrate || 12;
        penalrate = 2;
      }

      // Convert money types/strings to float
      const parseMoney = (val: any) => parseFloat(val.toString().replace(/[^0-9.-]+/g, "")) || 0;
      const sanctionedAmt = parseMoney(loan.sanctioned_amt);
      const noOfInstal = loan.no_of_instal || 1;
      const instalAmt = Math.round(sanctionedAmt / noOfInstal);

      // 5. Activate Loan: Insert into loan_master
      const insertLoanMasterQuery = `
        INSERT INTO loan_master (
          mbno, loantype, loancaseno, loan_amt, payment_date, 
          rate, no_of_instal, instal_amt, balance, openbalance, 
          purpose, intt_amount, penalrate
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `;
      await queryRunner.query(insertLoanMasterQuery, [
        loan.mbno, loan.loantype, loan.loancaseno, sanctionedAmt, new Date(),
        rate, noOfInstal, instalAmt, sanctionedAmt, sanctionedAmt,
        loan.purpose, 0, penalrate
      ]);

      // 6. Update loan_pending status
      await queryRunner.query(
        `UPDATE loan_pending SET flg_paid = 'Y' WHERE loancaseno::text = $1`,
        [loan.loancaseno]
      );

      // 7. Core Financial Posting: Ledger and Cashbook
      const maxLedgerIdResult = await queryRunner.query("SELECT COALESCE(MAX(ledgerid), 0) as max_id FROM ledger");
      let nextLedgerId = parseInt(maxLedgerIdResult[0].max_id) + 1;

      const maxTransNoResult = await queryRunner.query("SELECT COALESCE(MAX(trans_no), 0) as max_no FROM ledger");
      let nextTransNo = parseInt(maxTransNoResult[0].max_no) + 1;

      for (const entry of details) {
        const amt = parseFloat(entry.amount);
        const type = entry.type; // 'Receipt' or 'Payment'
        const mode = stagingVoucher.payment_mode === 'CASH' ? 'C' : 'T'; // C=Cash, T=Transfer

        // Ledger Insert
        const ledgerInsert = `
          INSERT INTO ledger (
            trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
            trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance,
            narration, username, ledgerid
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        `;

        await queryRunner.query(ledgerInsert, [
          nextTransNo, new Date(), type === 'Receipt' ? 'R' : 'P', entry.code, loan.mbno,
          loan.loancaseno, loan.loantype,
          amt, stagingVoucher.voucher_no, 'JV', mode, 0,
          stagingVoucher.narration, postedBy, nextLedgerId
        ]);

        // Cashbook Insert/Log
        const cbQuery = `
          INSERT INTO tblcashbook (headcode, headname, rcash, rtransfer, pcash, ptransfer, trans_date)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `;

        let rcash = 0, rtransfer = 0, pcash = 0, ptransfer = 0;
        if (type === 'Receipt') {
          if (mode === 'C') rcash = amt; else rtransfer = amt;
        } else {
          if (mode === 'C') pcash = amt; else ptransfer = amt;
        }

        await queryRunner.query(cbQuery, [
          entry.code, entry.name, rcash, rtransfer, pcash, ptransfer, new Date()
        ]);

        nextLedgerId++;
        nextTransNo++;
      }

      // 8. Lock Voucher in staging
      await queryRunner.query(
        `UPDATE voucher_staging SET status = 'POSTED', is_posted = TRUE WHERE voucher_no = $1`,
        [voucherNo]
      );

      await queryRunner.commitTransaction();
      console.log(`✅ Final Posting Complete for voucher: ${voucherNo}`);

      return {
        success: true,
        message: 'Transaction passed and posted successfully to Ledger and Cashbook',
        voucherNo: voucherNo
      };

    } catch (error) {
      await queryRunner.rollbackTransaction();
      console.error('❌ Error in pass transaction final posting:', error);
      throw new Error('Failed to post transaction: ' + error.message);
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get loan account code based on loan type
   */
  private getLoanAccountCode(loanType: string): string {
    const loanTypeCodes = {
      'Emergency': 'LOAN1',
      'Regular': 'LOAN2',
      'Loan Against Deposit': 'LOAN3',
      'Short Term': 'LOAN4',
      'Long Term': 'LOAN5'
    };

    return loanTypeCodes[loanType] || 'LOAN1';
  }

  /**
   * Find member by member number
   */
  async findByMemberNumber(memberNumber: string): Promise<MemberResponseDto> {
    const member = await this.memberRepository.findOne({
      where: { memberNumber },
    });

    if (!member) {
      throw new NotFoundException(`Member with number ${memberNumber} not found`);
    }

    return new MemberResponseDto(member);
  }

  /**
   * Restore a soft-deleted member
   */
  async restore(id: number): Promise<MemberResponseDto> {
    const member = await this.memberRepository.findOne({
      where: { id },
      withDeleted: true,
    });

    if (!member) {
      throw new NotFoundException(`Member with ID ${id} not found`);
    }

    if (!member.deletedAt) {
      throw new BadRequestException('Member is not deleted');
    }

    await this.memberRepository.restore(id);
    const restoredMember = await this.memberRepository.findOne({
      where: { id },
    });

    return new MemberResponseDto(restoredMember!);
  }
  async changeLoanSurety(caseNo: string, suretyData: { surety1: string, surety2?: string }) {
    const queryRunner = this.memberMasterRepository.manager.connection.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      this.logger.debug(`Changing sureties for loan case: ${caseNo}`);

      // 1. Update loan_pending
      const updateLpQuery = `
        UPDATE loan_pending 
        SET g1mbno = $1, g2mbno = $2 
        WHERE loancaseno::text = $3
        RETURNING mbno
      `;
      const lpResult = await queryRunner.query(updateLpQuery, [
        suretyData.surety1,
        suretyData.surety2 || '0',
        caseNo
      ]);

      if (lpResult.length === 0) {
        throw new Error('Loan case not found');
      }

      const mbNo = lpResult[0].mbno;

      // 2. Update suretymaster if exists
      const updateSmQuery = `
        UPDATE suretymaster 
        SET g1mbno = $1, g2mbno = $2 
        WHERE mbno = $3
      `;
      await queryRunner.query(updateSmQuery, [
        suretyData.surety1,
        suretyData.surety2 || '0',
        mbNo
      ]);

      await queryRunner.commitTransaction();
      this.logger.debug('Sureties changed and committed successfully');

      return {
        success: true,
        message: 'Loan sureties updated successfully'
      };

    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Error changing loan sureties for case ${caseNo}: ${error.message}`);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}