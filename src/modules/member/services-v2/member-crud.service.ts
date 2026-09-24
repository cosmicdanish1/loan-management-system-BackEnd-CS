import {
    Injectable,
    NotFoundException,
    ConflictException,
    BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import { Member } from '../entities/member.entity';
import { MemberMaster } from '../entities/member-master.entity';
import {
    CreateMemberDto,
    UpdateMemberDto,
    MemberResponseDto,
    SearchMemberDto,
} from '../dto';
import { MemberNumberUtil, MemberValidationUtil } from '../utils';
import { SequenceGeneratorService } from '../../shared/services';
import { SystemConfigService } from '../../admin/services/system-config.service';
import { RdMemberConfigService } from '../../rd/services/rd-member-config.service';
import { isDebitNormal } from '../../shared/utils/balance-direction';

/**
 * Member CRUD Service - Handles Create, Read, Update, Delete operations for members.
 * 
 * @version 2.0 - Part of backend restructuring
 * Extracted from member.service.ts for single responsibility
 */
@Injectable()
export class MemberCrudService {
    constructor(
        @InjectRepository(Member)
        private readonly memberRepository: Repository<Member>,
        @InjectRepository(MemberMaster)
        private readonly memberMasterRepository: Repository<MemberMaster>,
        private readonly dataSource: DataSource,
        private readonly sequenceGenerator: SequenceGeneratorService,
        private readonly systemConfigService: SystemConfigService,
        private readonly rdMemberConfig: RdMemberConfigService,
    ) { }

    /**
     * Generate next sequential member number
     */
    async generateNextMemberNumber(): Promise<string> {
        return this.sequenceGenerator.generateNextMemberNumber();
    }

    /**
     * Create a new member
     */
    async create(createMemberDto: CreateMemberDto): Promise<MemberResponseDto> {
        // Validate member data
        const validation = MemberValidationUtil.validateMemberData(createMemberDto);
        if (!validation.isValid) {
            throw new BadRequestException(validation.errors);
        }

        // --- Business Rules Validation ---
        const minAge = await this.systemConfigService.getConfigValue('RULE_MEMBER_MIN_AGE');
        const maxAge = await this.systemConfigService.getConfigValue('RULE_MEMBER_MAX_AGE');
        const minShareAmt = await this.systemConfigService.getConfigValue('RULE_MEMBER_MIN_SHARE_AMT');

        // Age validation
        if (!MemberValidationUtil.isValidAge(new Date(createMemberDto.dateOfBirth), minAge, maxAge)) {
            throw new BadRequestException(`Member age must be between ${minAge} and ${maxAge} years`);
        }

        // Share capital validation
        if ((createMemberDto.shareAmount || 0) < minShareAmt) {
            throw new BadRequestException(`Minimum share capital required is ₹${minShareAmt}`);
        }
        // ---------------------------------

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

        // --- Business Rules Validation (Updates) ---
        if (updateMemberDto.dateOfBirth) {
            const minAge = await this.systemConfigService.getConfigValue('RULE_MEMBER_MIN_AGE');
            const maxAge = await this.systemConfigService.getConfigValue('RULE_MEMBER_MAX_AGE');
            if (!MemberValidationUtil.isValidAge(new Date(updateMemberDto.dateOfBirth), minAge, maxAge)) {
                throw new BadRequestException(`Member age must be between ${minAge} and ${maxAge} years`);
            }
        }

        if (updateMemberDto.shareAmount !== undefined) {
            const minShareAmt = await this.systemConfigService.getConfigValue('RULE_MEMBER_MIN_SHARE_AMT');
            if (updateMemberDto.shareAmount < minShareAmt) {
                throw new BadRequestException(`Minimum share capital required is ₹${minShareAmt}`);
            }
        }
        // -------------------------------------------

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
     * Save or update member master (legacy table support)
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
            isactive = $27, flg_retire = $28, aadharno = $29, phoneno = $30, pan_no = $31,
            frs_no = $32, fathers_name = $33, branchmsno = $34,
            supanuationdate = $35, compulsory_deposit = $36, share_amount = $37, cast_category = $38
          WHERE mbno = $1
          RETURNING *
        `;

                const result = await this.dataSource.query(updateQuery, [
                    memberData.mbno, memberData.prefix, memberData.f_name, memberData.m_name,
                    memberData.l_name, memberData.sex, memberData.desig, memberData.present_address,
                    memberData.permanent_address, memberData.wingno, memberData.officeno, memberData.age,
                    memberData.dob, memberData.dor, memberData.gross_salary, memberData.basic_pay,
                    memberData.nominee_name, memberData.nominee_address, memberData.nominee_relation,
                    memberData.declare_date, memberData.memb_date, memberData.pfno, memberData.flg_insured,
                    memberData.insureamt, memberData.remarks, memberData.dept_name, memberData.isactive,
                    memberData.flg_retire, memberData.aadharno, memberData.phoneno, memberData.pan_no,
                    memberData.frs_no, memberData.fathers_name, memberData.branchmsno,
                    memberData.supanuationdate || null, memberData.compulsory_deposit || 0,
                    memberData.share_amount || 0, memberData.cast_category || ''
                ]);

                // Return raw row — TransformInterceptor handles the { success, data } envelope
                return result[0];
            } else {
                // Insert new member - use shared sequence generator
                const memberNumber = await this.sequenceGenerator.generateNextMemberNumber();

                // Wrapped in a transaction (unlike the plain dataSource.query()
                // used everywhere else in this method) because a new member
                // with a Compulsory Deposit amount now ALSO posts a real
                // ledger/cashbook/member_balances entry and starts RD for the
                // current financial year — per the user's explicit request
                // that RD auto-starts at member creation, using whatever
                // amount is in the Compulsory Deposit field. All three writes
                // (member row, CD posting, RD setup) must succeed or fail
                // together — a member should never end up half-created.
                const queryRunner = this.dataSource.createQueryRunner();
                await queryRunner.connect();
                await queryRunner.startTransaction();
                try {
                    // BUG FIX 2: INSERT was missing aadharno, phoneno, pan_no, frs_no,
                    // fathers_name, branchmsno — all present in the UPDATE path but silently
                    // dropped on new member creation. Added as $31–$36.
                    const insertQuery = `
          INSERT INTO member_master (
            mbno, prefix, f_name, m_name, l_name, sex, desig,
            present_address, permanent_address, wingno, officeno, age,
            dob, dor, gross_salary, basic_pay, nominee_name, nominee_address,
            nominee_relation, declare_date, memb_date, pfno, lfno, flg_incometax,
            flg_insured, insureamt, remarks, dept_name, isactive, flg_retire,
            aadharno, phoneno, pan_no, frs_no, fathers_name, branchmsno,
            supanuationdate, compulsory_deposit, share_amount, cast_category
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
            $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
            $25, $26, $27, $28, $29, $30,
            $31, $32, $33, $34, $35, $36,
            $37, $38, $39, $40
          )
          RETURNING *
        `;

                    const result = await queryRunner.query(insertQuery, [
                        memberNumber, memberData.prefix, memberData.f_name, memberData.m_name,
                        memberData.l_name, memberData.sex, memberData.desig, memberData.present_address,
                        memberData.permanent_address, memberData.wingno, memberData.officeno, memberData.age,
                        memberData.dob, memberData.dor, memberData.gross_salary, memberData.basic_pay,
                        memberData.nominee_name, memberData.nominee_address, memberData.nominee_relation,
                        memberData.declare_date, memberData.memb_date, memberData.pfno, memberData.lfno,
                        memberData.flg_incometax, memberData.flg_insured, memberData.insureamt,
                        memberData.remarks, memberData.dept_name, memberData.isactive, memberData.flg_retire,
                        memberData.aadharno || '', memberData.phoneno || '', memberData.pan_no || '',
                        memberData.frs_no || '', memberData.fathers_name || '', memberData.branchmsno || '',
                        memberData.supanuationdate || null, memberData.compulsory_deposit || 0,
                        memberData.share_amount || 0, memberData.cast_category || ''
                    ]);

                    const compulsoryDeposit = Number(memberData.compulsory_deposit) || 0;
                    // startRd defaults to true (checked by default on the
                    // form) — only skipped when explicitly unchecked.
                    const startRd = memberData.startRd !== false;

                    if (compulsoryDeposit > 0) {
                        await this.postInitialCompulsoryDeposit(
                            queryRunner, memberNumber, compulsoryDeposit, memberData.username || 'system',
                        );
                        if (startRd) {
                            await this.setupInitialRd(
                                queryRunner, memberNumber, compulsoryDeposit, memberData.username || 'system',
                            );
                        }
                    }

                    // FRS (MD) eligibility: a member who JOINS at age 50 or
                    // above is not eligible for the regular FRS contribution
                    // — only a nominal ₹2 is deducted instead. This is fixed
                    // at membership time based on age-at-joining, not
                    // re-evaluated later as an existing member ages past 50.
                    if (memberData.dob) {
                        const membershipDate = memberData.memb_date ? new Date(memberData.memb_date) : new Date();
                        const ageAtJoining = MemberValidationUtil.ageAtDate(new Date(memberData.dob), membershipDate);
                        if (ageAtJoining >= 50) {
                            await this.setFrsRestrictedAmount(queryRunner, memberNumber);
                        }
                    }

                    await queryRunner.commitTransaction();
                    // Return raw row — TransformInterceptor handles the { success, data } envelope
                    return result[0];
                } catch (error) {
                    await queryRunner.rollbackTransaction();
                    throw error;
                } finally {
                    await queryRunner.release();
                }
            }
        } catch (error) {
            console.error('[MemberCrudService] Error saving member master:', error);
            throw error;
        }
    }

    /**
     * Posts a NEW member's initial Compulsory Deposit as real money — ledger
     * entry (crediting L1004, the same GL head the RD system uses, since RD
     * and CD are the same product in this society), a cashbook entry (cash
     * received), and the member_balances running total. Previously this
     * field only ever wrote a number into member_master.compulsory_deposit
     * with no other effect at all — no ledger posting, no balance anywhere
     * else in the app that reads a member's real CD balance ever reflected
     * it. Runs on the caller's transaction (queryRunner) so it commits or
     * rolls back together with the member row itself.
     */
    private async postInitialCompulsoryDeposit(
        queryRunner: QueryRunner,
        mbno: string,
        amount: number,
        username: string,
    ): Promise<void> {
        const headRows = await queryRunner.query(`SELECT pflag FROM headmaster WHERE code = 'L1004'`);
        const direction = isDebitNormal(headRows[0]?.pflag) ? 'DR' : 'CR'; // L1004 is credit-normal -> 'CR'

        // voucherNumber is NOT a plain integer column in real data (e.g.
        // "P25883") -- confirmed live: a naive MAX(CAST(...AS INTEGER))
        // query (the same pattern compulsory-deposit.service.ts's bulk
        // interest posting uses) crashes on it. The shared sequence
        // generator is the safe, already-correct way to get both values.
        const voucherNo = await this.sequenceGenerator.getNextVoucherNumber();
        const nextVchrId = await this.sequenceGenerator.getNextVoucherId();
        await queryRunner.query(
            `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, status, remarks, "createdAt")
             VALUES ($1, $2, NOW(), 'JOURNAL', $3, $4, 'POSTED', 'NEW_MEMBER_CD', NOW())`,
            [nextVchrId, voucherNo, amount, 'Initial Compulsory Deposit - New Member'],
        );

        const nextLedgerId = (await queryRunner.query(`SELECT COALESCE(MAX(ledgerid), 0) + 1 as next_id FROM ledger`))[0].next_id;
        await queryRunner.query(
            `INSERT INTO ledger (trans_date, trans_type, code, mbno, trans_amt, receipt_vchr_no, vchr_type, pl_balance, narration, username, ledgerid)
             VALUES (NOW(), $1, 'L1004', $2, $3, $4, 'CD', $3, $5, $6, $7)`,
            [direction, mbno, amount, voucherNo, 'Initial Compulsory Deposit - New Member', username, nextLedgerId],
        );

        // Cash received at member onboarding — no mode-of-payment field
        // exists on this form yet, so this always posts as cash (rcash),
        // matching this app's convention elsewhere of defaulting to cash
        // when no transfer/cheque details are given.
        await queryRunner.query(
            `INSERT INTO tblcashbook (headcode, headname, rcash, rtransfer, pcash, ptransfer, trans_date)
             VALUES ('L1004', 'Compulsory Deposit', $1, 0, 0, 0, NOW())`,
            [amount],
        );

        const updated = await queryRunner.query(
            `UPDATE member_balances SET compulsory_deposit = COALESCE(compulsory_deposit, 0) + $1 WHERE mbno = $2 RETURNING mbno`,
            [amount, mbno],
        );
        if (updated[0].length === 0) {
            await queryRunner.query(
                `INSERT INTO member_balances (mbno, compulsory_deposit) VALUES ($1, $2)`,
                [mbno, amount],
            );
        }
    }

    /** Locks a member's FRS/MD monthly contribution (fundsmaster.mdamt) to
     *  the ₹2 nominal amount for members who joined at age 50+. fundsmaster
     *  has no unique constraint on mbno (confirmed live), so this uses the
     *  same UPDATE-then-INSERT-if-absent pattern as postInitialCompulsoryDeposit
     *  rather than an ON CONFLICT upsert. */
    private async setFrsRestrictedAmount(queryRunner: QueryRunner, mbno: string): Promise<void> {
        const updated = await queryRunner.query(
            `UPDATE fundsmaster SET mdamt = 2 WHERE mbno = $1 RETURNING mbno`,
            [mbno],
        );
        if (updated.length === 0) {
            await queryRunner.query(
                `INSERT INTO fundsmaster (mbno, mdamt) VALUES ($1, 2)`,
                [mbno],
            );
        }
    }

    /** Starts RD for a new member using the Compulsory Deposit amount as
     *  their monthly RD contribution for the current financial year — per
     *  the user's explicit request that RD auto-starts at member creation
     *  rather than needing a separate visit to RD Member Setup. Silently
     *  does nothing if there's no financial year currently active (should
     *  not happen in practice, but must never block member creation). */
    private async setupInitialRd(queryRunner: QueryRunner, mbno: string, monthlyAmount: number, username: string): Promise<void> {
        const yearRows = await queryRunner.query(
            `SELECT yearcode FROM yearend WHERE start_date <= NOW() AND end_date >= NOW() LIMIT 1`,
        );
        if (!yearRows[0]) return;
        await this.rdMemberConfig.setMonthlyAmount(
            mbno, Number(yearRows[0].yearcode), monthlyAmount, username, undefined, queryRunner,
        );
    }
}
