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
  ) {}

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
   * Find all members with pagination and search
   */
  async findAll(searchDto?: SearchMemberDto): Promise<{
    members: MemberResponseDto[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const {
      page = 1,
      limit = 10,
      sortBy = 'memberNumber',
      sortOrder = 'ASC',
      search,
      ...filters
    } = searchDto || {};

    const queryBuilder = this.memberRepository.createQueryBuilder('member');

    // Apply filters
    if (filters.memberNumber) {
      queryBuilder.andWhere('member.memberNumber = :memberNumber', {
        memberNumber: filters.memberNumber,
      });
    }

    if (filters.firstName) {
      queryBuilder.andWhere('member.firstName ILIKE :firstName', {
        firstName: `%${filters.firstName}%`,
      });
    }

    if (filters.lastName) {
      queryBuilder.andWhere('member.lastName ILIKE :lastName', {
        lastName: `%${filters.lastName}%`,
      });
    }

    if (filters.phoneNumber) {
      queryBuilder.andWhere('member.phoneNumber LIKE :phoneNumber', {
        phoneNumber: `%${filters.phoneNumber}%`,
      });
    }

    if (filters.email) {
      queryBuilder.andWhere('member.email ILIKE :email', {
        email: `%${filters.email}%`,
      });
    }

    if (filters.aadharNumber) {
      queryBuilder.andWhere('member.aadharNumber = :aadharNumber', {
        aadharNumber: filters.aadharNumber,
      });
    }

    if (filters.panNumber) {
      queryBuilder.andWhere('member.panNumber = :panNumber', {
        panNumber: filters.panNumber,
      });
    }

    if (filters.status) {
      queryBuilder.andWhere('member.status = :status', {
        status: filters.status,
      });
    }

    // General search across multiple fields
    if (search) {
      queryBuilder.andWhere(
        '(member.firstName ILIKE :search OR member.lastName ILIKE :search OR member.phoneNumber LIKE :search OR member.email ILIKE :search OR member.memberNumber ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    // Apply sorting
    queryBuilder.orderBy(`member.${sortBy}`, sortOrder);

    // Apply pagination
    const offset = (page - 1) * limit;
    queryBuilder.skip(offset).take(limit);

    const [members, total] = await queryBuilder.getManyAndCount();

    return {
      members: members.map(member => new MemberResponseDto(member)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
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
    const validation = MemberValidationUtil.validateMemberData({
      ...member,
      ...updateMemberDto,
    });
    if (!validation.isValid) {
      throw new BadRequestException(validation.errors);
    }

    // Check for duplicate phone number if being updated
    if (updateMemberDto.phoneNumber && updateMemberDto.phoneNumber !== member.phoneNumber) {
      const existingMemberByPhone = await this.memberRepository.findOne({
        where: { phoneNumber: updateMemberDto.phoneNumber },
      });
      if (existingMemberByPhone && existingMemberByPhone.id !== id) {
        throw new ConflictException('Member with this phone number already exists');
      }
    }

    // Check for duplicate email if being updated
    if (updateMemberDto.email && updateMemberDto.email !== member.email) {
      const existingMemberByEmail = await this.memberRepository.findOne({
        where: { email: updateMemberDto.email },
      });
      if (existingMemberByEmail && existingMemberByEmail.id !== id) {
        throw new ConflictException('Member with this email already exists');
      }
    }

    // Check for duplicate Aadhar if being updated
    if (updateMemberDto.aadharNumber && updateMemberDto.aadharNumber !== member.aadharNumber) {
      const existingMemberByAadhar = await this.memberRepository.findOne({
        where: { aadharNumber: updateMemberDto.aadharNumber },
      });
      if (existingMemberByAadhar && existingMemberByAadhar.id !== id) {
        throw new ConflictException('Member with this Aadhar number already exists');
      }
    }

    // Check for duplicate PAN if being updated
    if (updateMemberDto.panNumber && updateMemberDto.panNumber !== member.panNumber) {
      const existingMemberByPAN = await this.memberRepository.findOne({
        where: { panNumber: updateMemberDto.panNumber },
      });
      if (existingMemberByPAN && existingMemberByPAN.id !== id) {
        throw new ConflictException('Member with this PAN number already exists');
      }
    }

    // Format phone number if being updated
    if (updateMemberDto.phoneNumber) {
      updateMemberDto.phoneNumber = MemberValidationUtil.formatPhoneNumber(
        updateMemberDto.phoneNumber,
      );
    }

    // Convert date string to Date object if provided
    if (updateMemberDto.dateOfBirth) {
      (updateMemberDto as any).dateOfBirth = new Date(updateMemberDto.dateOfBirth);
    }

    // Update member
    await this.memberRepository.update(id, updateMemberDto);

    const updatedMember = await this.memberRepository.findOne({
      where: { id },
    });

    return new MemberResponseDto(updatedMember);
  }

  /**
   * Soft delete member
   */
  async remove(id: number): Promise<void> {
    const member = await this.memberRepository.findOne({
      where: { id },
    });

    if (!member) {
      throw new NotFoundException(`Member with ID ${id} not found`);
    }

    // Perform soft delete
    await this.memberRepository.softDelete(id);
  }

  /**
   * Restore soft deleted member
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

    return new MemberResponseDto(restoredMember);
  }

  /**
   * Get member statistics
   */
  async getStatistics(): Promise<{
    totalMembers: number;
    activeMembers: number;
    inactiveMembers: number;
    suspendedMembers: number;
    totalShareAmount: number;
  }> {
    const [
      totalMembers,
      activeMembers,
      inactiveMembers,
      suspendedMembers,
      shareAmountResult,
    ] = await Promise.all([
      this.memberRepository.count(),
      this.memberRepository.count({ where: { status: 'ACTIVE' } }),
      this.memberRepository.count({ where: { status: 'INACTIVE' } }),
      this.memberRepository.count({ where: { status: 'SUSPENDED' } }),
      this.memberRepository
        .createQueryBuilder('member')
        .select('SUM(member.shareAmount)', 'total')
        .getRawOne(),
    ]);

    return {
      totalMembers,
      activeMembers,
      inactiveMembers,
      suspendedMembers,
      totalShareAmount: parseFloat(shareAmountResult?.total || '0'),
    };
  }

  /**
   * Lookup members for loan application - Comprehensive data with loans
   */
  async lookupMembers(search?: string): Promise<MemberLookupResponseDto[]> {
    try {
      // Use raw query for comprehensive member data including loans
      let query = `
        SELECT 
          m.mbno,
          m.f_name || ' ' || COALESCE(m.m_name, '') || ' ' || m.l_name as member_name,
          COALESCE(d.name, 'Unknown') as office_name,
          m.basic_pay,
          m.dor,
          0 as share_balance,
          COALESCE((SELECT SUM(CASE 
             WHEN lm.balance IS NOT NULL AND lm.balance::text ~ '^[0-9]+\.?[0-9]*$' 
             THEN lm.balance::numeric 
             ELSE 0 
           END) 
           FROM loan_master lm 
           WHERE lm.mbno = m.mbno AND lm.loantype = 'RLN'), 0) as regular_loan_bal,
          COALESCE((SELECT SUM(CASE 
             WHEN lm.balance IS NOT NULL AND lm.balance::text ~ '^[0-9]+\.?[0-9]*$' 
             THEN lm.balance::numeric 
             ELSE 0 
           END) 
           FROM loan_master lm 
           WHERE lm.mbno = m.mbno AND lm.loantype = 'ELN'), 0) as emergency_loan_bal
        FROM member_master m
        LEFT JOIN division_master d ON m.officeno = d.officeno
        WHERE (m.isactive = 'Y' OR m.isactive IS NULL)
      `;

      const params: any[] = [];
      
      // Apply search filter if provided
      if (search) {
        query += ` AND (
          m.mbno::text LIKE $1 OR 
          m.f_name ILIKE $1 OR 
          m.l_name ILIKE $1 OR
          d.name ILIKE $1
        )`;
        params.push(`%${search}%`);
      }

      query += ` AND m.mbno IS NOT NULL ORDER BY m.mbno DESC LIMIT 500`;

      const members = await this.memberMasterRepository.query(query, params);

      console.log(`Found ${members.length} members in lookup`);

      return members.map((member: any) => ({
        memberNo: member.mbno?.toString() || '',
        name: member.member_name?.trim() || '',
        basicPay: member.basic_pay?.toString() || '0',
        dateOfRetire: member.dor ? new Date(member.dor).toLocaleDateString('en-GB') : '',
        officeNo: member.office_name || '',
        address: '',
        shareBalance: member.share_balance?.toString() || '0',
        regularLoanBal: member.regular_loan_bal?.toString() || '0',
        emergencyLoanBal: member.emergency_loan_bal?.toString() || '0',
      }));
    } catch (error) {
      console.error('Error in lookupMembers:', error);
      return [];
    }
  }

  /**
   * Get pending loan cases only (for Loan Payment dropdown)
   * Pending = balance equals loan amount (no payments made yet)
   */
  async getAllLoanCases() {
    try {
      const query = `
        SELECT 
          lm.loancaseno,
          lm.mbno,
          lm.loantype,
          lm.loan_amt::numeric as loan_amt,
          lm.payment_date,
          lm.purpose,
          lm.balance::numeric as balance,
          mm.f_name || ' ' || COALESCE(mm.m_name, '') || ' ' || mm.l_name as member_name
        FROM loan_master lm
        JOIN member_master mm ON lm.mbno = mm.mbno
        WHERE lm.balance::numeric = lm.loan_amt::numeric
        ORDER BY lm.loancaseno DESC
        LIMIT 500
      `;

      const loans = await this.memberMasterRepository.query(query);
      console.log(`Found ${loans.length} pending loan cases`);

      return loans.map((loan: any) => {
        const loanAmt = parseFloat(loan.loan_amt) || 0;
        const balance = parseFloat(loan.balance) || 0;
        
        return {
          loanCaseNo: loan.loancaseno?.toString() || '',
          memberNo: loan.mbno?.toString() || '',
          memberName: loan.member_name?.trim() || '',
          loanType: loan.loantype || '',
          appliedAmount: loan.loan_amt?.toString() || '0',
          balance: balance.toString(),
          applicationDate: loan.payment_date ? new Date(loan.payment_date).toLocaleDateString('en-GB') : '',
          purpose: loan.purpose || '',
          status: 'PENDING'
        };
      });
    } catch (error) {
      console.error('Error getting pending loan cases:', error);
      console.error('Error details:', error.message);
      return [];
    }
  }

  /**
   * Get loan details by case number (for Loan Payment modal)
   * Fetches from loan_pending (for pending loans) or loan_master (for active loans)
   */
  async getLoanDetailsByCaseNo(caseNo: string) {
    try {
      // First try loan_pending for complete information including sureties
      const pendingQuery = `
        SELECT 
          lp.loancaseno,
          lp.loantype,
          lp.mbno,
          lp.applied_amt::numeric as applied_amt,
          lp.sanctioned_amt::numeric as sanctioned_amt,
          lp.app_date,
          lp.sanctioned_date,
          lp.no_of_instal,
          lp.purpose,
          lp.form_number,
          lp.g1mbno,
          lp.g2mbno,
          lp.g3mbno,
          mm.f_name || ' ' || COALESCE(mm.m_name, '') || ' ' || mm.l_name as member_name,
          mm.officeno,
          dm.name as office_name,
          mm.basic_pay,
          0 as share_amount,
          s1.f_name || ' ' || COALESCE(s1.m_name, '') || ' ' || s1.l_name as surety1_name,
          d1.name as surety1_office,
          COALESCE((SELECT SUM(balance::numeric) FROM loan_master WHERE mbno = lp.g1mbno), 0) as surety1_balance,
          s2.f_name || ' ' || COALESCE(s2.m_name, '') || ' ' || s2.l_name as surety2_name,
          d2.name as surety2_office,
          COALESCE((SELECT SUM(balance::numeric) FROM loan_master WHERE mbno = lp.g2mbno), 0) as surety2_balance
        FROM loan_pending lp
        JOIN member_master mm ON lp.mbno = mm.mbno
        LEFT JOIN division_master dm ON mm.officeno = dm.officeno
        LEFT JOIN member_master s1 ON lp.g1mbno = s1.mbno
        LEFT JOIN division_master d1 ON s1.officeno = d1.officeno
        LEFT JOIN member_master s2 ON lp.g2mbno = s2.mbno
        LEFT JOIN division_master d2 ON s2.officeno = d2.officeno
        WHERE lp.loancaseno = $1
      `;

      let result = await this.memberMasterRepository.query(pendingQuery, [caseNo]);
      
      if (result.length > 0) {
        const loan = result[0];
        return {
          loanCaseNo: loan.loancaseno?.toString() || '',
          loanType: loan.loantype || '',
          memberNo: loan.mbno?.toString() || '',
          memberName: loan.member_name?.trim() || '',
          officeNo: loan.office_name || loan.officeno?.toString() || '',
          subDivision: loan.office_name || '',
          appliedAmount: loan.applied_amt?.toString() || '0',
          applicationDate: loan.app_date ? new Date(loan.app_date).toLocaleDateString('en-GB') : '',
          basicPay: loan.basic_pay?.toString() || '0',
          currentBalance: loan.sanctioned_amt?.toString() || loan.applied_amt?.toString() || '0',
          shareAmount: loan.share_amount?.toString() || '0',
          purpose: loan.purpose || '',
          formNumber: loan.form_number || '0',
          rate: '0',
          penalRate: '0',
          noOfInstallments: loan.no_of_instal?.toString() || '0',
          installmentAmount: '0',
          sanctionedAmount: loan.sanctioned_amt?.toString() || loan.applied_amt?.toString() || '0',
          sanctionDate: loan.sanctioned_date ? new Date(loan.sanctioned_date).toLocaleDateString('en-GB') : '',
          interestAmount: '0',
          surety1Gr: loan.g1mbno?.toString() || '0',
          surety1Name: loan.surety1_name?.trim() || '',
          surety1Office: loan.surety1_office || '',
          surety1LoanBalance: loan.surety1_balance?.toString() || '0',
          surety2Gr: loan.g2mbno?.toString() || '0',
          surety2Name: loan.surety2_name?.trim() || '',
          surety2Office: loan.surety2_office || '',
          surety2LoanBalance: loan.surety2_balance?.toString() || '0'
        };
      }

      // If not in loan_pending, try loan_master
      const masterQuery = `
        SELECT 
          lm.loancaseno,
          lm.loantype,
          lm.mbno,
          lm.loan_amt::numeric as loan_amt,
          lm.payment_date,
          lm.rate::numeric as rate,
          lm.penalrate,
          lm.no_of_instal,
          lm.instal_amt::numeric as instal_amt,
          lm.balance::numeric as balance,
          lm.purpose,
          lm.intt_amount,
          mm.f_name || ' ' || COALESCE(mm.m_name, '') || ' ' || mm.l_name as member_name,
          mm.officeno,
          dm.name as office_name,
          mm.basic_pay,
          0 as share_amount
        FROM loan_master lm
        JOIN member_master mm ON lm.mbno = mm.mbno
        LEFT JOIN division_master dm ON mm.officeno = dm.officeno
        WHERE lm.loancaseno = $1
      `;

      result = await this.memberMasterRepository.query(masterQuery, [caseNo]);
      
      if (result.length === 0) {
        return null;
      }

      const loan = result[0];
      
      return {
        loanCaseNo: loan.loancaseno?.toString() || '',
        loanType: loan.loantype || '',
        memberNo: loan.mbno?.toString() || '',
        memberName: loan.member_name?.trim() || '',
        officeNo: loan.office_name || loan.officeno?.toString() || '',
        subDivision: loan.office_name || '',
        appliedAmount: loan.loan_amt?.toString() || '0',
        applicationDate: loan.payment_date ? new Date(loan.payment_date).toLocaleDateString('en-GB') : '',
        basicPay: loan.basic_pay?.toString() || '0',
        currentBalance: loan.balance?.toString() || '0',
        shareAmount: loan.share_amount?.toString() || '0',
        purpose: loan.purpose || '',
        formNumber: '0',
        rate: loan.rate?.toString() || '0',
        penalRate: loan.penalrate?.toString() || '0',
        noOfInstallments: loan.no_of_instal?.toString() || '0',
        installmentAmount: loan.instal_amt?.toString() || '0',
        sanctionedAmount: loan.loan_amt?.toString() || '0',
        sanctionDate: loan.payment_date ? new Date(loan.payment_date).toLocaleDateString('en-GB') : '',
        interestAmount: loan.intt_amount?.toString() || '0',
        surety1Gr: '0',
        surety1Name: '',
        surety1Office: '',
        surety1LoanBalance: '0',
        surety2Gr: '0',
        surety2Name: '',
        surety2Office: '',
        surety2LoanBalance: '0'
      };
    } catch (error) {
      console.error('Error getting loan details:', error);
      console.error('Error details:', error.message);
      return null;
    }
  }

  /**
   * Update loan with sanction details
   * Updates loan_master with rates and installment details
   */
  async updateLoanSanction(caseNo: string, sanctionData: any) {
    try {
      const query = `
        UPDATE loan_master
        SET 
          rate = $1::money,
          penalrate = $2,
          no_of_instal = $3,
          instal_amt = $4::money,
          payment_date = $5
        WHERE loancaseno = $6
        RETURNING *
      `;

      const values = [
        sanctionData.rate || 0,
        sanctionData.penalRate || 0,
        sanctionData.noOfInstallments || 0,
        sanctionData.installmentAmount || 0,
        sanctionData.sanctionDate || new Date(),
        caseNo
      ];

      const result = await this.memberMasterRepository.query(query, values);
      
      console.log(`✅ Loan ${caseNo} sanctioned successfully`);
      
      return {
        success: true,
        message: 'Loan sanctioned successfully',
        data: result[0]
      };
    } catch (error) {
      console.error('❌ Error updating loan sanction:', error);
      console.error('Error details:', error.message);
      throw new Error('Failed to update loan sanction: ' + error.message);
    }
  }

  /**
   * Get existing loan cases for a member
   */
  async getMemberLoanCases(memberNo: string) {
    try {
      const query = `
        SELECT 
          mbno,
          loantype,
          loancaseno,
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
        memberNo: loan.mbno?.toString() || '',
        loanType: loan.loantype || '',
        loanCaseNo: loan.loancaseno?.toString() || '',
        loanAmount: loan.loan_amt?.toString() || '0',
        balance: loan.balance?.toString() || '0',
        purpose: loan.purpose || '',
      }));
    } catch (error) {
      console.error('Error in getMemberLoanCases:', error);
      return [];
    }
  }

  /**
   * Get member details by member number from member_master table
   */
  async getMemberDetailsByNumber(memberNo: string) {
    try {
      const query = `
        SELECT 
          m.mbno,
          m.prefix,
          m.f_name,
          m.m_name,
          m.l_name,
          m.sex,
          m.desig,
          m.present_address,
          m.permanent_address,
          m.wingno,
          m.officeno,
          m.age,
          m.dob,
          m.date_of_appt,
          m.dor,
          m.gross_salary,
          m.basic_pay,
          m.nominee_name,
          m.nominee_address,
          m.nominee_relation,
          m.declare_date,
          m.flg_retire,
          m.memb_date,
          m.pfno,
          m.flg_insured,
          m.insureamt,
          m.remarks,
          m.dept_name,
          m.isactive,
          d.name as office_name,
          0 as share_amt,
          0 as monthly_subscription,
          0 as compulsory_deposit
        FROM member_master m
        LEFT JOIN division_master d ON m.officeno = d.officeno
        WHERE m.mbno = $1
      `;

      const result = await this.memberMasterRepository.query(query, [memberNo]);
      
      if (result.length === 0) {
        return null;
      }

      const member = result[0];
      
      // Helper function to format date to YYYY-MM-DD for HTML5 date inputs
      const formatDate = (date: any): string => {
        if (!date) return '';
        const d = new Date(date);
        if (isNaN(d.getTime())) return '';
        return d.toISOString().split('T')[0];
      };

      return {
        memberNumber: member.mbno?.toString() || '',
        title: member.prefix || 'Mr',
        firstName: member.f_name || '',
        middleName: member.m_name || '',
        lastName: member.l_name || '',
        gender: member.sex === 'M' ? 'male' : 'female',
        dateOfBirth: formatDate(member.dob),
        age: parseInt(member.age) || 0,
        srNoEpfPfNo: member.pfno || '',
        designation: member.desig || '',
        basicPay: member.basic_pay?.toString() || '0',
        shareAmt: member.share_amt?.toString() || '0',
        retirementDate: formatDate(member.dor),
        membershipDate: formatDate(member.memb_date),
        department: member.dept_name || '',
        homeAddress: member.present_address || '',
        permanentAddress: member.permanent_address || '',
        status: member.flg_retire === 'Y' ? 'Retired' : 'Regular',
        dateOfWithdrawRetire: formatDate(member.dor),
        castCategory: 'General',
        memberType: 'Regular',
        divisionRo: member.office_name || '',
        branch: member.office_name || '',
        nomineeName: member.nominee_name || '',
        nomineeAddress: member.nominee_address || '',
        relationWithNominee: member.nominee_relation || '',
        declarationDate: formatDate(member.declare_date),
        remarks: member.remarks || '',
        isActive: member.isactive === 'Y',
        isInsured: member.flg_insured === 'Y',
        amountOfInsurance: member.insureamt?.toString() || '0',
        monthlyContribution: member.monthly_subscription?.toString() || '0',
        compulsatoryDeposit: member.compulsory_deposit?.toString() || '0'
      };
    } catch (error) {
      console.error('Error getting member details:', error);
      return null;
    }
  }

  /**
   * Save or update member in member_master table
   */
  async saveMemberMaster(memberData: any) {
    try {
      console.log('Saving member data:', memberData);

      // Check if member exists
      const existingMember = await this.memberMasterRepository.query(
        'SELECT mbno FROM member_master WHERE mbno = $1',
        [memberData.memberNumber]
      );

      const isUpdate = existingMember.length > 0;

      if (isUpdate) {
        // Update existing member
        const updateQuery = `
          UPDATE member_master SET
            prefix = $2,
            f_name = $3,
            m_name = $4,
            l_name = $5,
            sex = $6,
            desig = $7,
            present_address = $8,
            permanent_address = $9,
            wingno = $10,
            officeno = $11,
            age = $12,
            dob = $13,
            dor = $14,
            gross_salary = $15,
            basic_pay = $16,
            nominee_name = $17,
            nominee_address = $18,
            nominee_relation = $19,
            declare_date = $20,
            memb_date = $21,
            pfno = $22,
            flg_insured = $23,
            insureamt = $24,
            remarks = $25,
            dept_name = $26,
            isactive = $27,
            flg_retire = $28
          WHERE mbno = $1
          RETURNING *
        `;

        // Map division/office data - extract office number from division selection
        let officeno = 0;
        let wingno = '0';
        
        if (memberData.divisionRo) {
          // Extract office number from division format like "1-BHILAI" or "BHILAI"
          const divisionMatch = memberData.divisionRo.match(/^(\d+)-/);
          if (divisionMatch) {
            officeno = parseInt(divisionMatch[1]);
            wingno = divisionMatch[1];
          } else {
            // Default office mapping for divisions without numbers
            const officeMap: any = {
              'BHILAI': 1,
              'POWER HOUSE': 2,
              'RISALI': 3,
              'NANDINI': 4,
              'DALLI RAJHRA': 5,
              'MECON': 6
            };
            officeno = officeMap[memberData.divisionRo] || 1;
            wingno = officeno.toString();
          }
        }

        const values = [
          memberData.memberNumber,                                    // $1 mbno (WHERE clause)
          memberData.title || 'Mr',                                   // $2 prefix
          memberData.firstName || '',                                 // $3 f_name
          memberData.middleName || '',                                // $4 m_name
          memberData.lastName || '',                                  // $5 l_name
          memberData.gender === 'male' ? 'M' : 'F',                  // $6 sex
          memberData.designation || '',                               // $7 desig
          memberData.homeAddress || '',                               // $8 present_address
          memberData.homeAddress || '',                               // $9 permanent_address
          wingno,                                                     // $10 wingno
          officeno,                                                   // $11 officeno
          memberData.age?.toString() || '0',                          // $12 age
          memberData.dateOfBirth ? new Date(memberData.dateOfBirth) : null, // $13 dob
          memberData.retirementDate ? new Date(memberData.retirementDate) : null, // $14 dor
          parseFloat(memberData.basicPay) || 0,                       // $15 gross_salary
          parseFloat(memberData.basicPay) || 0,                       // $16 basic_pay
          memberData.nomineeName || '',                               // $17 nominee_name
          memberData.nomineeAddress || '',                            // $18 nominee_address
          memberData.relationWithNominee || '',                       // $19 nominee_relation
          memberData.declarationDate ? new Date(memberData.declarationDate) : null, // $20 declare_date
          memberData.membershipDate ? new Date(memberData.membershipDate) : null, // $21 memb_date
          memberData.srNoEpfPfNo || '',                               // $22 pfno
          memberData.isInsured ? 'Y' : 'N',                          // $23 flg_insured
          parseFloat(memberData.amountOfInsurance) || 0,              // $24 insureamt
          memberData.remarks || '',                                   // $25 remarks
          memberData.department || '',                                // $26 dept_name
          memberData.isActive ? 'Y' : 'N',                           // $27 isactive
          memberData.status === 'Retired' ? 'Y' : 'N'                // $28 flg_retire
        ];

        const result = await this.memberMasterRepository.query(updateQuery, values);
        console.log('✅ Member updated successfully');
        
        return {
          success: true,
          message: 'Member updated successfully',
          data: result[0]
        };
      } else {
        // Insert new member
        const insertQuery = `
          INSERT INTO member_master (
            mbno, prefix, f_name, m_name, l_name, sex, desig,
            present_address, permanent_address, wingno, officeno, age, 
            dob, dor, gross_salary, basic_pay, nominee_name, nominee_address, 
            nominee_relation, declare_date, memb_date, pfno, lfno, 
            flg_incometax, flg_insured, insureamt, remarks, dept_name, 
            isactive, flg_retire
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
            $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, 
            $24, $25, $26, $27, $28, $29, $30
          )
          RETURNING *
        `;

        // Map division/office data - extract office number from division selection
        let officeno = 0;
        let wingno = '0';
        
        if (memberData.divisionRo) {
          // Extract office number from division format like "1-BHILAI" or "BHILAI"
          const divisionMatch = memberData.divisionRo.match(/^(\d+)-/);
          if (divisionMatch) {
            officeno = parseInt(divisionMatch[1]);
            wingno = divisionMatch[1];
          } else {
            // Default office mapping for divisions without numbers
            const officeMap: any = {
              'BHILAI': 1,
              'POWER HOUSE': 2,
              'RISALI': 3,
              'NANDINI': 4,
              'DALLI RAJHRA': 5,
              'MECON': 6
            };
            officeno = officeMap[memberData.divisionRo] || 1;
            wingno = officeno.toString();
          }
        }

        const values = [
          memberData.memberNumber,                                    // $1 mbno
          memberData.title || 'Mr',                                   // $2 prefix
          memberData.firstName || '',                                 // $3 f_name
          memberData.middleName || '',                                // $4 m_name
          memberData.lastName || '',                                  // $5 l_name
          memberData.gender === 'male' ? 'M' : 'F',                  // $6 sex
          memberData.designation || '',                               // $7 desig
          memberData.homeAddress || '',                               // $8 present_address
          memberData.homeAddress || '',                               // $9 permanent_address (same as present)
          wingno,                                                     // $10 wingno
          officeno,                                                   // $11 officeno
          memberData.age?.toString() || '0',                          // $12 age
          memberData.dateOfBirth ? new Date(memberData.dateOfBirth) : null, // $13 dob
          memberData.retirementDate ? new Date(memberData.retirementDate) : null, // $14 dor
          parseFloat(memberData.basicPay) || 0,                       // $15 gross_salary (same as basic)
          parseFloat(memberData.basicPay) || 0,                       // $16 basic_pay
          memberData.nomineeName || '',                               // $17 nominee_name
          memberData.nomineeAddress || '',                            // $18 nominee_address
          memberData.relationWithNominee || '',                       // $19 nominee_relation
          memberData.declarationDate ? new Date(memberData.declarationDate) : null, // $20 declare_date
          memberData.membershipDate ? new Date(memberData.membershipDate) : null, // $21 memb_date
          memberData.srNoEpfPfNo || '',                               // $22 pfno
          '',                                                         // $23 lfno (empty)
          'N',                                                        // $24 flg_incometax
          memberData.isInsured ? 'Y' : 'N',                          // $25 flg_insured
          parseFloat(memberData.amountOfInsurance) || 0,              // $26 insureamt
          memberData.remarks || '',                                   // $27 remarks
          memberData.department || '',                                // $28 dept_name
          memberData.isActive ? 'Y' : 'N',                           // $29 isactive
          memberData.status === 'Retired' ? 'Y' : 'N'                // $30 flg_retire
        ];

        const result = await this.memberMasterRepository.query(insertQuery, values);
        console.log('✅ New member created successfully');
        console.log('📋 Insert result:', result);
        console.log('🔍 Inserted member number:', result[0]?.mbno);
        
        return {
          success: true,
          message: 'New member created successfully',
          data: result[0]
        };
      }
    } catch (error) {
      console.error('❌ Error saving member:', error);
      throw new Error('Failed to save member: ' + error.message);
    }
  }

  /**
   * Generate next sequential member number (8 digits)
   * Finds the highest existing member number and increments by 1
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
      let maxMemberNo = result[0]?.max_member_no;
      
      // Convert to number if it's a string
      if (typeof maxMemberNo === 'string') {
        maxMemberNo = parseInt(maxMemberNo);
      }
      
      // If no valid 8-digit members exist, start from 10000000
      if (!maxMemberNo || maxMemberNo < 10000000 || maxMemberNo > 99999999) {
        maxMemberNo = 10000000;
      }
      
      const nextMemberNo = maxMemberNo + 1;

      // Ensure it's exactly 8 digits and within valid range
      if (nextMemberNo > 99999999) {
        throw new Error('Member number range exhausted. Please contact administrator.');
      }

      const memberNumber = nextMemberNo.toString().padStart(8, '0');

      console.log(`Generated next member number: ${memberNumber} (previous max: ${maxMemberNo})`);

      return memberNumber;
    } catch (error) {
      console.error('Error generating member number:', error);
      // Fallback to timestamp-based generation (8 digits)
      const timestamp = Date.now().toString();
      const fallbackNumber = timestamp.slice(-8).padStart(8, '1');
      console.log(`Using fallback member number: ${fallbackNumber}`);
      return fallbackNumber;
    }
  }

  /**
   * Generate next sequential loan case number
   * Finds the highest existing loan case number and increments by 1
   */
  async generateNextLoanCaseNo(): Promise<string> {
    try {
      const query = `
        SELECT MAX(CAST(loancaseno AS INTEGER)) as max_case_no
        FROM loan_master
        WHERE loancaseno ~ '^[0-9]+$'
      `;

      const result = await this.memberMasterRepository.query(query);
      const maxCaseNo = result[0]?.max_case_no || 10000; // Start from 10001 if no cases exist
      const nextCaseNo = maxCaseNo + 1;

      console.log(`Generated next loan case number: ${nextCaseNo}`);

      return nextCaseNo.toString();
    } catch (error) {
      console.error('Error generating loan case number:', error);
      // Fallback to timestamp-based generation
      const timestamp = Date.now().toString();
      return timestamp.slice(-5);
    }
  }

  /**
   * Save loan application to database
   */
  async saveLoanApplication(loanData: any) {
    try {
      console.log('Starting loan application save process...');
      console.log('Input data:', loanData);

      // Generate loan case number if not provided
      let loanCaseNo = loanData.loanCaseNo;
      if (!loanCaseNo) {
        console.log('No loan case number provided, generating new one...');
        loanCaseNo = await this.generateNextLoanCaseNo();
        console.log('Generated loan case number:', loanCaseNo);
      }

      // Parse loan type - extract first 3 characters if longer
      let loanType = loanData.loanType;
      if (loanType && loanType.length > 3) {
        // Extract code from format like "EMERGENCY LOAN" -> "ELN"
        const typeMap: any = {
          'EMERGENCY LOAN': 'ELN',
          'REGULAR LOAN': 'RLN',
          'ADVANCE LOAN': 'ALN'
        };
        loanType = typeMap[loanType] || loanType.substring(0, 3);
      }

      console.log('Processed loan type:', loanType);

      // Insert into loan_master table with correct columns
      // Note: loan_amt, balance, openbalance, rate, instal_amt are MONEY type
      // mbno, loancaseno, intt_amount, penalrate are NUMERIC type
      const insertQuery = `
        INSERT INTO loan_master (
          mbno,
          loantype,
          loancaseno,
          loan_amt,
          payment_date,
          rate,
          no_of_instal,
          instal_amt,
          balance,
          openbalance,
          purpose,
          intt_amount,
          penalrate
        ) VALUES ($1, $2, $3, $4::money, $5, $6::money, $7, $8::money, $9::money, $10::money, $11, $12, $13)
        RETURNING *
      `;

      const loanAmount = parseFloat(loanData.loanAmount) || 0;

      const values = [
        loanData.memberNo,                    // $1 mbno (numeric)
        loanType,                             // $2 loantype (varchar)
        loanCaseNo,                           // $3 loancaseno (numeric)
        loanAmount,                           // $4 loan_amt (money) - cast in query
        loanData.applDate || new Date(),      // $5 payment_date (timestamp)
        0,                                    // $6 rate (money) - cast in query
        0,                                    // $7 no_of_instal (smallint)
        0,                                    // $8 instal_amt (money) - cast in query
        loanAmount,                           // $9 balance (money) - cast in query
        loanAmount,                           // $10 openbalance (money) - cast in query
        loanData.reason || '',                // $11 purpose (varchar)
        null,                                 // $12 intt_amount (numeric) - nullable
        0                                     // $13 penalrate (numeric)
      ];

      console.log('Executing insert with values:', values);

      const result = await this.memberMasterRepository.query(insertQuery, values);

      console.log(`✅ Loan application saved successfully. Case No: ${loanCaseNo}`);

      return {
        success: true,
        loanCaseNo,
        message: 'Loan application saved successfully',
        data: result[0]
      };
    } catch (error) {
      console.error('❌ Error saving loan application:', error);
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      throw new Error('Failed to save loan application: ' + error.message);
    }
  }
}
