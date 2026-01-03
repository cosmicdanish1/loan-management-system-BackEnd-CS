import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
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

@Injectable()
export class MemberService {
  constructor(
    @InjectRepository(Member)
    private readonly memberRepository: Repository<Member>,
    @InjectRepository(MemberMaster)
    private readonly memberMasterRepository: Repository<MemberMaster>,
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
      console.log('🔍 Looking up members with search:', search, 'limit:', limit, 'offset:', offset);

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

      console.log('📋 Executing query with limit:', actualLimit, 'offset:', actualOffset);
      const result = await this.memberMasterRepository.query(query);
      console.log('📊 Query result count:', result.length);

      const mappedResult = result.map((member: any) => ({
        memberNo: member.memberno,
        memberName: member.membername,
        officeNo: member.officeno,
        wingNo: member.wingno,
        officeName: member.officename
      }));

      console.log('✅ Mapped result count:', mappedResult.length);
      return mappedResult;
    } catch (error) {
      console.error('❌ Error in lookupMembers:', error);
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

      console.log(`Found ${loanCases.length} loan cases for member ${memberNo}`);

      return loanCases.map((loan: any) => ({
        memberNo,
        loanCaseNo: loan.loancaseno,
        loanType: loan.loantype,
        loanAmount: loan.loan_amt,
        balance: loan.balance,
        purpose: loan.purpose
      }));
    } catch (error) {
      console.error('Error getting member loan cases:', error);
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
      console.error('Error getting member details:', error);
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
        const updateQuery = `
          UPDATE member_master SET
            prefix = $2, f_name = $3, m_name = $4, l_name = $5, sex = $6, desig = $7,
            present_address = $8, permanent_address = $9, wingno = $10, officeno = $11, age = $12,
            dob = $13, dor = $14, gross_salary = $15, basic_pay = $16, nominee_name = $17,
            nominee_address = $18, nominee_relation = $19, declare_date = $20, memb_date = $21,
            pfno = $22, flg_insured = $23, insureamt = $24, remarks = $25, dept_name = $26,
            isactive = $27, flg_retire = $28
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
          memberData.flg_retire
        ]);

        return { success: true, data: result[0] };
      } else {
        // Insert new member
        const memberNumber = await this.generateNextMemberNumber();

        const insertQuery = `
          INSERT INTO member_master (
            mbno, prefix, f_name, m_name, l_name, sex, desig,
            present_address, permanent_address, wingno, officeno, age,
            dob, dor, gross_salary, basic_pay, nominee_name, nominee_address,
            nominee_relation, declare_date, memb_date, pfno, lfno, flg_incometax,
            flg_insured, insureamt, remarks, dept_name, isactive, flg_retire
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
            $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
            $25, $26, $27, $28, $29, $30
          )
          RETURNING *
        `;

        const result = await this.memberMasterRepository.query(insertQuery, [
          memberNumber, memberData.prefix, memberData.f_name, memberData.m_name,
          memberData.l_name, memberData.sex, memberData.desig, memberData.present_address,
          memberData.permanent_address, memberData.wingno, memberData.officeno, memberData.age,
          memberData.dob, memberData.dor, memberData.gross_salary, memberData.basic_pay,
          memberData.nominee_name, memberData.nominee_address, memberData.nominee_relation,
          memberData.declare_date, memberData.memb_date, memberData.pfno, memberData.lfno,
          memberData.flg_incometax, memberData.flg_insured, memberData.insureamt,
          memberData.remarks, memberData.dept_name, memberData.isactive, memberData.flg_retire
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
      const query = `
        SELECT MAX(mbno::bigint) as max_member_no
        FROM member_master
        WHERE mbno IS NOT NULL
        AND mbno::text ~ '^[0-9]+$'
        AND LENGTH(mbno::text) = 8
      `;

      const result = await this.memberMasterRepository.query(query);
      const maxMemberNo = result[0]?.max_member_no;

      if (maxMemberNo) {
        const nextNumber = (parseInt(maxMemberNo) + 1).toString().padStart(8, '0');
        const memberNumber = nextNumber;
        console.log(`Generated next member number: ${memberNumber} (previous max: ${maxMemberNo})`);
        return memberNumber;
      } else {
        // Fallback to starting number
        const fallbackNumber = '10000001';
        console.log(`Using fallback member number: ${fallbackNumber}`);
        return fallbackNumber;
      }
    } catch (error) {
      console.error('Error generating member number:', error);
      throw new Error('Failed to generate member number');
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
          no_of_instal, purpose, flg_sanctioned, flg_paid
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
        'N'  // flg_paid = 'N' (not paid yet)
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
        WHERE lp.flg_sanctioned = 'Y' AND lp.flg_paid = 'N'
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
        applicationDate: loan.application_date
      }));
    } catch (error) {
      console.error('Error getting loan cases:', error);
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
          TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.m_name, '') || ' ' || COALESCE(mm.l_name, '')) as member_name
        FROM loan_pending lp
        JOIN member_master mm ON lp.mbno = mm.mbno
        WHERE lp.loancaseno = $1
      `;

      const result = await this.memberMasterRepository.query(query, [caseNo]);

      if (result.length === 0) {
        return null;
      }

      const loan = result[0];

      return {
        loanCaseNo: loan.loancaseno,
        memberNo: loan.mbno,
        memberName: loan.member_name,
        loanType: loan.loantype,
        appliedAmount: loan.applied_amt,
        sanctionedAmount: loan.sanctioned_amt,
        applicationDate: loan.app_date,
        sanctionDate: loan.sanctioned_date,
        noOfInstallments: loan.no_of_instal,
        purpose: loan.purpose,
        formNumber: loan.form_number || '0',
        surety1: loan.g1mbno || '0',
        surety2: loan.g2mbno || '0',
        surety3: loan.g3mbno || '0'
      };
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
        WHERE loancaseno = $4
        RETURNING *
      `;

      const result = await this.memberMasterRepository.query(updateQuery, [
        sanctionData.sanctionedAmount,
        sanctionData.sanctionDate,
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
    try {
      console.log('🎯 Generating voucher for loan disbursement:', voucherData);

      // 1. Get and increment voucher number
      const voucherNumber = await this.getNextVoucherNumber();

      // 2. Get next voucher ID
      const voucherId = await this.getNextVoucherId();

      // 3. Validate loan case exists and is sanctioned
      const loanQuery = `
        SELECT loancaseno, mbno, sanctioned_amt, flg_sanctioned, flg_paid
        FROM loan_pending 
        WHERE loancaseno = $1 AND flg_sanctioned = 'Y' AND flg_paid = 'N'
      `;

      const loanResult = await this.memberMasterRepository.query(loanQuery, [voucherData.loanCaseNo]);

      if (loanResult.length === 0) {
        throw new Error('Loan case not found or not sanctioned or already disbursed');
      }

      const loan = loanResult[0];

      // 4. Insert voucher to existing vouchers table
      const insertQuery = `
        INSERT INTO vouchers (
          "id", "voucherNumber", "voucherDate", "voucherType", "totalAmount", 
          "description", "memberId", "payeeName", "chequeNumber", 
          "chequeDate", "bankName", "status", "remarks", "createdAt"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING *
      `;

      const insertValues = [
        voucherId,
        voucherNumber,
        new Date(),
        'LOAN_DISBURSEMENT',
        voucherData.amount || loan.sanctioned_amt,
        voucherData.narration || `Loan disbursement for case ${voucherData.loanCaseNo}`,
        parseInt(loan.mbno),
        `Loan Case: ${voucherData.loanCaseNo}`,
        voucherData.chequeNo || null,
        voucherData.chequeDate || null,
        voucherData.bankName || null,
        'PENDING', // Status: PENDING until posted to ledger
        `Loan Case: ${voucherData.loanCaseNo}, Payment Mode: ${voucherData.paymentMode}`,
        new Date()
      ];

      const voucherResult = await this.memberMasterRepository.query(insertQuery, insertValues);

      console.log(`✅ Voucher ${voucherNumber} generated successfully`);

      return {
        success: true,
        message: 'Voucher generated successfully',
        voucherNo: voucherNumber,
        data: voucherResult[0]
      };

    } catch (error) {
      console.error('❌ Error generating voucher:', error);
      throw new Error('Failed to generate voucher: ' + error.message);
    }
  }

  /**
   * Get next sequential voucher number
   * Format: VCH001, VCH002, VCH003...
   * Uses existing voucher_master table for numbering
   */
  private async getNextVoucherNumber(): Promise<string> {
    try {
      // Get current max voucher number from vouchers table
      const getMaxQuery = `
        SELECT COALESCE(MAX(CAST(SUBSTRING("voucherNumber" FROM 4) AS INTEGER)), 0) as max_num
        FROM vouchers 
        WHERE "voucherNumber" LIKE 'VCH%'
      `;

      const maxResult = await this.memberMasterRepository.query(getMaxQuery);
      const currentMax = maxResult[0]?.max_num || 0;
      const nextNumber = currentMax + 1;

      // Format as VCH001, VCH002, etc.
      const voucherNumber = `VCH${nextNumber.toString().padStart(3, '0')}`;

      console.log(`📄 Generated voucher number: ${voucherNumber}`);
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
          v.*,
          lp.loantype,
          TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.m_name, '') || ' ' || COALESCE(mm.l_name, '')) as member_name
        FROM vouchers v
        JOIN loan_pending lp ON v.remarks LIKE '%Loan Case: ' || lp.loancaseno || '%'
        JOIN member_master mm ON v."memberId" = mm.mbno
        WHERE v.status = 'PENDING' AND v."voucherType" = 'LOAN_DISBURSEMENT'
        ORDER BY v."voucherDate" DESC
      `;

      const result = await this.memberMasterRepository.query(query);

      console.log(`📋 Found ${result.length} pending vouchers`);

      return result.map((voucher: any) => ({
        id: voucher.id,
        voucherNo: voucher.voucherNumber,
        loanCaseNo: voucher.remarks.match(/Loan Case: ([^,]+)/)?.[1] || '',
        memberNo: voucher.memberId,
        memberName: voucher.member_name,
        loanType: voucher.loantype,
        amount: voucher.totalAmount,
        paymentMode: voucher.remarks.match(/Payment Mode: ([^,]+)/)?.[1] || '',
        chequeNo: voucher.chequeNumber,
        bankName: voucher.bankName,
        chequeDate: voucher.chequeDate,
        narration: voucher.description,
        createdDate: voucher.voucherDate,
        createdBy: 'system'
      }));

    } catch (error) {
      console.error('❌ Error fetching pending vouchers:', error);
      throw new Error('Failed to fetch pending vouchers: ' + error.message);
    }
  }

  /**
   * Pass Transaction - Final Posting (Step 4)
   * Move voucher from vouchers table to permanent ledger (IRREVERSIBLE)
   */
  async passTransaction(voucherNo: string, postedBy: string = 'admin') {
    const queryRunner = this.memberMasterRepository.manager.connection.createQueryRunner();

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      console.log(`🔒 Starting Pass Transaction for voucher: ${voucherNo}`);

      // 1. Fetch voucher details with loan and member info
      const voucherQuery = `
        SELECT 
          v.*,
          lp.loantype, lp.sanctioned_amt, lp.no_of_instal, 
          lp.purpose,
          TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.m_name, '') || ' ' || COALESCE(mm.l_name, '')) as member_name
        FROM vouchers v
        JOIN loan_pending lp ON v.remarks LIKE '%Loan Case: ' || lp.loancaseno || '%'
        JOIN member_master mm ON v."memberId" = mm.mbno
        WHERE v."voucherNumber" = $1 AND v.status = 'PENDING'
      `;

      const voucherResult = await queryRunner.query(voucherQuery, [voucherNo]);

      if (voucherResult.length === 0) {
        throw new Error('Voucher not found or already posted');
      }

      const voucher = voucherResult[0];
      const loanCaseNo = voucher.remarks.match(/Loan Case: ([^,]+)/)?.[1] || '';
      const paymentMode = voucher.remarks.match(/Payment Mode: ([^,]+)/)?.[1] || 'CASH';

      console.log(`📄 Processing voucher for member: ${voucher.member_name}`);

      // 2. Get next transaction number
      const transNoQuery = `SELECT COALESCE(MAX(trans_no), 0) + 1 as next_trans_no FROM transactions`;
      const transNoResult = await queryRunner.query(transNoQuery);
      const nextTransNo = transNoResult[0].next_trans_no;

      // 3. Insert to transactions table (staging for ledger)
      const transactionQuery = `
        INSERT INTO transactions (
          trans_no, trans_type, trans_date, mbno, acc_type, trans_amt,
          receipt_vchr_no, vchr_type, modeofpay, cheq_no, cheq_amt,
          cheq_date, bankname, pass_flag, narration, username
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      `;

      await queryRunner.query(transactionQuery, [
        nextTransNo,                           // trans_no
        'LN',                                  // trans_type (Loan)
        new Date(),                            // trans_date
        voucher.memberId,                      // mbno
        'LOAN',                               // acc_type
        voucher.totalAmount,                   // trans_amt
        voucherNo,                            // receipt_vchr_no
        'LN',                                 // vchr_type
        paymentMode === 'BANK' ? 'BK' : 'CS', // modeofpay (2 chars max for transactions table)
        voucher.chequeNumber || null,          // cheq_no
        voucher.totalAmount,                   // cheq_amt
        voucher.chequeDate || null,            // cheq_date
        voucher.bankName || null,              // bankname
        'Y',                                  // pass_flag (posted)
        voucher.description,                   // narration
        postedBy                              // username
      ]);

      // 4. Insert Debit Entry to Ledger (Loan Account)
      const ledgerIdQuery = `SELECT COALESCE(MAX(ledgerid), 0) + 1 as next_ledger_id FROM ledger`;
      const ledgerIdResult = await queryRunner.query(ledgerIdQuery);
      let nextLedgerId = ledgerIdResult[0].next_ledger_id;

      const debitLedgerQuery = `
        INSERT INTO ledger (
          trans_no, trans_date, trans_type, code, mbno, acc_type, trans_amt,
          receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `;

      const loanAccountCode = this.getLoanAccountCode(voucher.loantype);
      const debitNarration = `Loan disbursement - ${voucherNo} - ${voucher.member_name}`;

      await queryRunner.query(debitLedgerQuery, [
        nextTransNo,                          // trans_no
        new Date(),                           // trans_date
        'LN',                                // trans_type
        loanAccountCode,                      // code (loan account)
        voucher.memberId,                     // mbno
        'LOAN',                              // acc_type
        voucher.totalAmount,                  // trans_amt (debit)
        voucherNo,                           // receipt_vchr_no
        'LN',                                // vchr_type
        paymentMode === 'BANK' ? 'B' : 'C',  // modeofpay (1 char max: B=Bank, C=Cash)
        voucher.totalAmount,                  // pl_balance (loan balance)
        debitNarration,                       // narration
        postedBy,                            // username
        nextLedgerId++                       // ledgerid
      ]);

      // 5. Insert Credit Entry to Ledger (Bank/Cash Account)
      const creditAccountCode = paymentMode === 'BANK' ? 'BANK1' : 'CASH1';
      const creditNarration = `Loan disbursement payment - ${voucherNo} - ${voucher.member_name}`;

      await queryRunner.query(debitLedgerQuery, [
        nextTransNo,                          // trans_no
        new Date(),                           // trans_date
        'LN',                                // trans_type
        creditAccountCode,                    // code (bank/cash account)
        voucher.memberId,                     // mbno
        paymentMode === 'BANK' ? 'BANK' : 'CASH', // acc_type
        -voucher.totalAmount,                 // trans_amt (credit - negative)
        voucherNo,                           // receipt_vchr_no
        'LN',                                // vchr_type
        paymentMode === 'BANK' ? 'B' : 'C',  // modeofpay (1 char max: B=Bank, C=Cash)
        -voucher.totalAmount,                 // pl_balance (negative for outflow)
        creditNarration,                      // narration
        postedBy,                            // username
        nextLedgerId++                       // ledgerid
      ]);

      // 6. Insert Cash Book Entry (if cash payment)
      if (paymentMode === 'CASH') {
        const cashBookQuery = `
          INSERT INTO tblcashbook (
            headcode, headname, pcash, trans_date
          ) VALUES ($1, $2, $3, $4)
        `;

        await queryRunner.query(cashBookQuery, [
          'CASH1',                                             // headcode
          `Loan disbursement to ${voucher.member_name}`,       // headname
          voucher.totalAmount,                                 // pcash (payment cash)
          new Date()                                           // trans_date
        ]);
      }

      // 7. Create Active Loan in loan_master (if table exists)
      try {
        const loanMasterQuery = `
          INSERT INTO loan_master (
            mbno, loantype, loancaseno, loan_amt, payment_date, rate,
            no_of_instal, instal_amt, balance, openbalance, purpose, penalrate
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `;

        await queryRunner.query(loanMasterQuery, [
          voucher.memberId,                     // mbno
          voucher.loantype,                     // loantype
          loanCaseNo,                          // loancaseno
          voucher.sanctioned_amt,               // loan_amt (money type)
          new Date(),                           // payment_date (disbursement date)
          12.5,                                // rate (money type - default rate)
          voucher.no_of_instal || 60,           // no_of_instal
          Math.round(voucher.sanctioned_amt / (voucher.no_of_instal || 60)), // instal_amt (money type)
          voucher.sanctioned_amt,               // balance (initial = full amount)
          voucher.sanctioned_amt,               // openbalance (opening = full amount)
          voucher.purpose || '',                // purpose
          2.0                                  // penalrate (default penalty rate)
        ]);
      } catch (error) {
        console.log('⚠️ loan_master table not found, skipping loan master entry');
      }

      // 8. Mark Loan as Disbursed in loan_pending
      const updateLoanQuery = `
        UPDATE loan_pending SET
          flg_paid = 'Y',
          payment_date = $1
        WHERE loancaseno = $2
      `;

      await queryRunner.query(updateLoanQuery, [
        new Date(),
        loanCaseNo
      ]);

      // 9. Mark Voucher as Posted in vouchers table
      const updateVoucherQuery = `
        UPDATE vouchers SET
          status = 'POSTED',
          "authorizedBy" = 1,
          "authorizedAt" = $1
        WHERE "voucherNumber" = $2
      `;

      await queryRunner.query(updateVoucherQuery, [
        new Date(),
        voucherNo
      ]);

      // Commit transaction
      await queryRunner.commitTransaction();

      console.log(`✅ Transaction posted successfully for voucher: ${voucherNo}`);

      return {
        success: true,
        message: 'Transaction posted successfully',
        voucherNo: voucherNo,
        postedBy: postedBy,
        postedAt: new Date()
      };

    } catch (error) {
      await queryRunner.rollbackTransaction();
      console.error('❌ Error in pass transaction:', error);
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
}