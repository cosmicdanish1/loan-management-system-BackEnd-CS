import { lockLedgerIds } from '../../shared/utils/ledger-lock';
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
import type { FieldProblem } from '../../../common/validation/friendly-validation';

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

    /** Read-only preview of the number the next Save will get (does not consume it). */
    async peekNextMemberNumber(): Promise<string> {
        return this.sequenceGenerator.peekNextMemberNumber();
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
    async findOne(id: number): Promise<any> {
        // Members live in member_master (keyed by member number). The old query read a legacy `members` table that does
        // not exist, so every call failed with 'Database Error'. (ES-312) `id` is the member number here.
        const rows = await this.dataSource.query(`SELECT * FROM member_master WHERE mbno = $1`, [id]);
        if (!rows || rows.length === 0) {
            throw new NotFoundException(`Member ${id} not found`);
        }
        return rows[0];
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

        // Validate only what was sent (a partial update must not demand every required field again)
        const validation = MemberValidationUtil.validateMemberUpdate(updateMemberDto);
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
        // Delete a member only while it has no accounts or history; otherwise refuse and say what holds it. (ES-312)
        const existing = await this.dataSource.query(`SELECT mbno FROM member_master WHERE mbno = $1`, [id]);
        if (!existing || existing.length === 0) {
            throw new NotFoundException(`Member ${id} not found`);
        }

        const holders: Array<[string, string]> = [
            ['ledger entries', `SELECT COUNT(*)::int AS n FROM ledger WHERE mbno = $1`],
            ['loans', `SELECT COUNT(*)::int AS n FROM loan_master WHERE mbno = $1`],
            ['loan applications', `SELECT COUNT(*)::int AS n FROM loan_pending WHERE mbno = $1`],
            ['savings accounts', `SELECT COUNT(*)::int AS n FROM sbmaster WHERE mbno = $1`],
            ['RD instalments', `SELECT COUNT(*)::int AS n FROM rd_installment_ledger WHERE mbno::text = $1::text`],
            ['transactions', `SELECT COUNT(*)::int AS n FROM transactions WHERE mbno = $1`],
        ];
        const blocking: string[] = [];
        for (const [label, sql] of holders) {
            const r = await this.dataSource.query(sql, [id]);
            if (Number(r[0]?.n) > 0) blocking.push(`${r[0].n} ${label}`);
        }
        const funds = await this.dataSource.query(
            `SELECT COALESCE(ABS(mdamt),0)+COALESCE(ABS(cdamt),0)+COALESCE(ABS(shareamt),0) AS total FROM fundsmaster WHERE mbno = $1`, [id]);
        if (Number(funds[0]?.total) > 0) blocking.push('a non-zero share / deposit balance');
        if (blocking.length > 0) {
            throw new ConflictException(`Member ${id} cannot be deleted: it has ${blocking.join(', ')}.`);
        }

        const qr = this.dataSource.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        try {
            await qr.query(`DELETE FROM fundsmaster WHERE mbno = $1`, [id]);
            await qr.query(`DELETE FROM member_balances WHERE mbno = $1`, [id]);
            await qr.query(`DELETE FROM rd_member_config WHERE mbno::text = $1::text`, [id]);
            await qr.query(`DELETE FROM member_master WHERE mbno = $1`, [id]);
            await qr.commitTransaction();
        } catch (e) {
            await qr.rollbackTransaction();
            throw e;
        } finally {
            await qr.release();
        }
    }

    /**
     * Save or update member master (legacy table support)
     */
    /** ES-481: plain field messages (same shape as the global validation pipe) instead of "Database operation failed". */
    private assertMemberFields(d: any, existing: any = null): void {
        const problems: FieldProblem[] = [];
        const blank = (v: any) => v === undefined || v === null || String(v).trim() === '';
        // ES-309: format rules apply to what is NEW. When an existing member is edited, a value that is the same as the
        // stored one is not checked again, so members migrated with an old-style phone / dates can still be edited.
        const norm = (v: any): string => {
            if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
            const s = String(v ?? '').trim();
            return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
        };
        const changed = (field: string): boolean => !existing || norm(existing[field]) !== norm(d?.[field]);
        const bad = (field: string, label: string, code: string, message: string, params?: Record<string, string | number>) =>
            problems.push({ field, label, code, message, ...(params ? { params } : {}) });
        const req = (field: string, label: string) => {
            if (blank(d?.[field])) problems.push({ field, label, code: 'FIELD_REQUIRED', message: `${label} is required.` });
        };
        req('f_name', 'First name');
        req('officeno', 'Office');
        for (const [field, label] of [['age', 'Age'], ['gross_salary', 'Gross salary'], ['basic_pay', 'Basic pay'],
            ['compulsory_deposit', 'Compulsory deposit'], ['share_amount', 'Share amount'], ['insureamt', 'Insurance amount']] as const) {
            const v = d?.[field];
            if (blank(v)) continue;
            if (!Number.isFinite(Number(v))) problems.push({ field, label, code: 'FIELD_NUMBER', message: `${label} must be a number.` });
            else if (Number(v) < 0) problems.push({ field, label, code: 'FIELD_MIN', message: `${label} cannot be less than 0.`, params: { min: 0 } });
        }
        for (const [field, label] of [['dob', 'Date of birth'], ['dor', 'Retirement date'], ['memb_date', 'Membership date']] as const) {
            const v = d?.[field];
            if (!blank(v) && Number.isNaN(new Date(v).getTime())) problems.push({ field, label, code: 'FIELD_DATE', message: `${label} must be a valid date.` });
        }

        // ---- ES-309 ----
        const textLimits: Array<[string, string, number]> = [
            ['f_name', 'First name', 50], ['m_name', 'Middle name', 50], ['l_name', 'Last name', 50], ['fathers_name', "Father's name", 100],
            ['desig', 'Designation', 40], ['dept_name', 'Department', 50], ['present_address', 'Present address', 200],
            ['permanent_address', 'Permanent address', 200], ['nominee_name', 'Nominee name', 40], ['remarks', 'Remarks', 100],
            ['pfno', 'PF number', 10], ['prefix', 'Title', 10], ['frs_no', 'FRS number', 20], ['wingno', 'Wing', 6],
        ];
        for (const [field, label, max] of textLimits) {
            const v = d?.[field];
            if (!blank(v) && changed(field) && String(v).length > max) bad(field, label, 'FIELD_MAX_LENGTH', `${label} can be at most ${max} characters.`, { max });
        }
        for (const [field, label] of [['gross_salary', 'Gross salary'], ['basic_pay', 'Basic pay'], ['compulsory_deposit', 'Compulsory deposit'],
            ['share_amount', 'Share amount'], ['insureamt', 'Insurance amount']] as const) {
            const v = d?.[field];
            if (!blank(v) && Number.isFinite(Number(v)) && Number(v) > 99999999.99 && changed(field)) bad(field, label, 'FIELD_MAX', `${label} cannot be more than 9,99,99,999.99.`, { max: 99999999.99 });
        }
        if (!blank(d?.age) && Number.isFinite(Number(d.age)) && Number(d.age) >= 0 && changed('age')
            && (!Number.isInteger(Number(d.age)) || Number(d.age) > 99)) bad('age', 'Age', 'FIELD_INTEGER', 'Age must be a whole number from 0 to 99.');
        if (!blank(d?.sex) && changed('sex') && !/^[MFOT]$/i.test(String(d.sex).trim())) bad('sex', 'Gender', 'FIELD_FORMAT', 'Gender must be M, F, O or T.');
        const phone = String(d?.phoneno ?? '').trim();
        if (phone && changed('phoneno')) {
            const digits = phone.replace(/\D/g, '').length;
            if (!/^[0-9+\-\s()]+$/.test(phone) || digits < 10 || digits > 15) bad('phoneno', 'Phone number', 'FIELD_FORMAT', 'Phone number must have 10 to 15 digits (digits, spaces, + and - only).');
        }
        const aadhaar = String(d?.aadharno ?? '').trim();
        if (aadhaar && changed('aadharno') && !/^\d{12}$/.test(aadhaar.replace(/[\s-]/g, ''))) bad('aadharno', 'Aadhaar number', 'FIELD_FORMAT', 'Aadhaar number must have exactly 12 digits.');
        const pan = String(d?.pan_no ?? '').trim();
        if (pan && changed('pan_no') && !/^[A-Za-z]{5}\d{4}[A-Za-z]$/.test(pan)) bad('pan_no', 'PAN', 'FIELD_FORMAT', 'PAN must look like ABCDE1234F (5 letters, 4 digits, 1 letter).');
        const dobT = blank(d?.dob) ? NaN : new Date(d.dob).getTime();
        const dorValue = !blank(d?.dor) ? d.dor : d?.date_of_retirement;
        const dorT = blank(dorValue) ? NaN : new Date(dorValue).getTime();
        if (Number.isFinite(dobT) && changed('dob')) {
            if (dobT > Date.now()) bad('dob', 'Date of birth', 'FIELD_DATE_FUTURE', 'Date of birth cannot be in the future.');
            else if (dobT < new Date('1900-01-01').getTime()) bad('dob', 'Date of birth', 'FIELD_DATE_RANGE', 'Date of birth cannot be before 1900.');
        }
        if (Number.isFinite(dobT) && Number.isFinite(dorT) && dorT < dobT
            && (changed('dob') || (!blank(d?.dor) ? changed('dor') : changed('date_of_retirement')))) {
            bad('dor', 'Retirement date', 'FIELD_DATE_ORDER', 'Retirement date cannot be before the date of birth.');
        }
        if (problems.length) {
            throw new BadRequestException({
                statusCode: 400, error: 'Bad Request', code: 'VALIDATION_FAILED',
                message: problems.map((p) => p.message), errors: problems,
            });
        }
    }

    async saveMemberMaster(memberData: any) {
        // ES-309: when an existing member is edited, only changed values are format-checked (see assertMemberFields)
        let existing: any = null;
        if (memberData?.mbno && memberData.mbno !== 'auto' && /^\d+$/.test(String(memberData.mbno).trim())) {
            try {
                existing = (await this.dataSource.query(`SELECT * FROM member_master WHERE mbno = $1`, [String(memberData.mbno).trim()]))?.[0] ?? null;
            } catch { existing = null; }
        }
        this.assertMemberFields(memberData, existing);
        try {
            // ES-99: date_of_retirement is the single retirement date. Clients may still
            // send it as `dor`; accept either and write the same value to both columns.
            if (memberData.date_of_retirement && !memberData.dor) {
                memberData.dor = memberData.date_of_retirement;
            }
            memberData.dor = memberData.dor || null;
            if (memberData.mbno && memberData.mbno !== 'auto') {
                // Update existing member
                const updateQuery = `
          UPDATE member_master SET
            prefix = $2, f_name = $3, m_name = $4, l_name = $5, sex = $6, desig = $7,
            present_address = $8, permanent_address = $9, wingno = $10, officeno = $11, age = $12,
            dob = $13, dor = $14, date_of_retirement = $14, gross_salary = $15, basic_pay = $16, nominee_name = $17,
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

                // A pg UPDATE ... RETURNING through TypeORM answers [rows, rowCount]; unwrap it so an update returns the
                // same single row object as a create, and an unknown member number is a 404, not a silent 201. (ES-311)
                const updatedRows: any[] = Array.isArray(result[0]) ? result[0] : result;
                if (!updatedRows || updatedRows.length === 0) {
                    throw new NotFoundException(`Member ${memberData.mbno} not found`);
                }
                return updatedRows[0];
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
            dob, dor, date_of_retirement, gross_salary, basic_pay, nominee_name, nominee_address,
            nominee_relation, declare_date, memb_date, pfno, lfno, flg_incometax,
            flg_insured, insureamt, remarks, dept_name, isactive, flg_retire,
            aadharno, phoneno, pan_no, frs_no, fathers_name, branchmsno,
            supanuationdate, compulsory_deposit, share_amount, cast_category
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
            $13, $14, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
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

        await lockLedgerIds(queryRunner); // ES-445
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
        const updatedRows = Array.isArray(updated[0]) ? updated[0] : updated; // [rows, count] shape
        if (updatedRows.length === 0) {
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
