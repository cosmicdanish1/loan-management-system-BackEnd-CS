import {
    Injectable,
    Logger,
    NotFoundException,
    ConflictException,
    BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
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
import { generateVoucherNo } from '../../shared/utils/voucher-utils';

/**
 * Member CRUD Service - Handles Create, Read, Update, Delete operations for members.
 * 
 * @version 2.0 - Part of backend restructuring
 * Extracted from member.service.ts for single responsibility
 */
@Injectable()
export class MemberCrudService {
    private readonly logger = new Logger(MemberCrudService.name);

    constructor(
        @InjectRepository(Member)
        private readonly memberRepository: Repository<Member>,
        @InjectRepository(MemberMaster)
        private readonly memberMasterRepository: Repository<MemberMaster>,
        private readonly dataSource: DataSource,
        private readonly sequenceGenerator: SequenceGeneratorService,
        private readonly systemConfigService: SystemConfigService,
    ) { }

    /**
     * Generate next sequential member number (defaults to BHILAI branch code 61)
     */
    async generateNextMemberNumber(branchCode: string = '61'): Promise<string> {
        return this.sequenceGenerator.generateNextMemberNumber(branchCode);
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
    // BUG FIX 16: findAll()/getStatistics() queried `this.memberRepository` — the disconnected
    // `Member` entity (`members` table) that `create()` writes to, which nothing in the running
    // app actually uses for real member data. Every real member is created via saveMemberMaster()
    // into `member_master`, so this always returned empty/wrong results. Confirmed live: Journal
    // Transfer Entry's member picker falls back to `GET /members?limit=300` when its primary
    // search call throws, and that fallback was silently returning nothing. Rewritten to query
    // `member_master` directly via raw SQL, matching the pattern already proven correct in
    // saveMemberMaster() and MemberLookupService.
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
            sortBy = 'memberNumber',
            sortOrder = 'ASC',
        } = searchDto;

        const conditions: string[] = [];
        const params: any[] = [];
        const p = (v: any) => { params.push(v); return `$${params.length}`; };

        if (search) {
            const s = `%${search}%`;
            conditions.push(`(mbno::text ILIKE ${p(s)} OR f_name ILIKE ${p(s)} OR l_name ILIKE ${p(s)} OR phoneno ILIKE ${p(s)} OR email ILIKE ${p(s)})`);
        }
        if (memberNumber) conditions.push(`mbno::text ILIKE ${p(`%${memberNumber}%`)}`);
        if (firstName) conditions.push(`f_name ILIKE ${p(`%${firstName}%`)}`);
        if (lastName) conditions.push(`l_name ILIKE ${p(`%${lastName}%`)}`);
        if (phoneNumber) conditions.push(`phoneno ILIKE ${p(`%${phoneNumber}%`)}`);
        if (email) conditions.push(`email ILIKE ${p(`%${email}%`)}`);
        if (status) conditions.push(`isactive = ${p(status === 'ACTIVE' ? 'Y' : 'N')}`);

        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const sortColumnMap: Record<string, string> = {
            memberNumber: 'mbno', firstName: 'f_name', lastName: 'l_name',
            createdAt: 'mbno', updatedAt: 'mbno', // member_master has no timestamp columns
        };
        const sortColumn = sortColumnMap[sortBy] || 'mbno';
        const sortDir = sortOrder === 'DESC' ? 'DESC' : 'ASC';

        const countResult = await this.dataSource.query(
            `SELECT COUNT(*) AS total FROM member_master ${whereClause}`, params,
        );
        const total = parseInt(countResult[0]?.total || '0', 10);

        const skip = (page - 1) * limit;
        const rows = await this.dataSource.query(
            `SELECT mbno, f_name, m_name, l_name, phoneno, email, isactive, officeno, wingno
             FROM member_master ${whereClause}
             ORDER BY ${sortColumn} ${sortDir}
             LIMIT ${p(limit)} OFFSET ${p(skip)}`,
            params,
        );

        return {
            data: rows.map((r: any) => ({
                memberNumber: r.mbno,
                firstName: r.f_name,
                lastName: r.l_name,
                fullName: [r.f_name, r.m_name, r.l_name].filter(Boolean).join(' '),
                phoneNumber: r.phoneno,
                email: r.email,
                status: r.isactive === 'Y' ? 'ACTIVE' : 'INACTIVE',
            })),
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
        const counts = await this.dataSource.query(
            `SELECT
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE isactive = 'Y') AS active,
               COUNT(*) FILTER (WHERE isactive != 'Y' OR isactive IS NULL) AS inactive
             FROM member_master`,
        );
        const totalMembers = parseInt(counts[0]?.total || '0', 10);
        const activeMembers = parseInt(counts[0]?.active || '0', 10);
        const inactiveMembers = parseInt(counts[0]?.inactive || '0', 10);
        const suspendedMembers = 0; // member_master has no separate "suspended" state

        return {
            totalMembers,
            activeMembers,
            inactiveMembers,
            suspendedMembers,
        };
    }

    // 4.2 (F-001) fix: findOne/update/updateStatus/remove all queried
    // `this.memberRepository` — the disconnected `Member` entity (`members` table,
    // 0 rows) — same bug class as the already-fixed findAll()/getStatistics().
    // Every real member lives in `member_master`, keyed by `mbno` (not a small
    // sequential id), so `:id` here means mbno. Column set kept intentionally
    // narrow to what MemberResponseDto exposes; member_master has no
    // createdAt/updatedAt/occupation columns, so those are left undefined
    // rather than invented.
    private static readonly MEMBER_MASTER_COLUMNS =
        'mbno, f_name, l_name, dob, present_address, phoneno, email, aadharno, pan_no, desig, share_amount, isactive';

    private mapMemberMasterToResponseDto(row: any): MemberResponseDto {
        return new MemberResponseDto({
            id: Number(row.mbno),
            memberNumber: row.mbno,
            firstName: row.f_name || '',
            lastName: row.l_name || '',
            dateOfBirth: row.dob,
            address: row.present_address || '',
            phoneNumber: row.phoneno || '',
            email: row.email || undefined,
            aadharNumber: row.aadharno || undefined,
            panNumber: row.pan_no || undefined,
            occupation: row.desig || undefined,
            shareAmount: Number(row.share_amount) || 0,
            status: row.isactive === 'Y' ? 'ACTIVE' : 'INACTIVE',
        });
    }

    /**
     * Find member by ID (mbno)
     */
    async findOne(id: number): Promise<MemberResponseDto> {
        const rows = await this.dataSource.query(
            `SELECT ${MemberCrudService.MEMBER_MASTER_COLUMNS} FROM member_master WHERE mbno = $1`,
            [id],
        );

        if (!rows[0]) {
            throw new NotFoundException(`Member with ID ${id} not found`);
        }

        return this.mapMemberMasterToResponseDto(rows[0]);
    }

    /**
     * Update member
     */
    async update(id: number, updateMemberDto: UpdateMemberDto): Promise<MemberResponseDto> {
        const rows = await this.dataSource.query(
            `SELECT ${MemberCrudService.MEMBER_MASTER_COLUMNS} FROM member_master WHERE mbno = $1`,
            [id],
        );
        const member = rows[0];

        if (!member) {
            throw new NotFoundException(`Member with ID ${id} not found`);
        }

        // Validate updated fields — validateMemberData() requires firstName/lastName/
        // dateOfBirth/address/phoneNumber unconditionally, which is correct for create()
        // but wrong for a partial PATCH: it was never exercised here before because
        // update() always 404'd first on the disconnected table, so every real member's
        // partial update would have been rejected for omitting unrelated fields the
        // moment findOne() started working. Only validate the format of fields actually
        // present in this update.
        const updateErrors: string[] = [];
        if (updateMemberDto.dateOfBirth && !MemberValidationUtil.isValidAge(new Date(updateMemberDto.dateOfBirth))) {
            updateErrors.push('Member must be between 18 and 100 years old');
        }
        if (updateMemberDto.phoneNumber && !MemberValidationUtil.isValidPhoneNumber(updateMemberDto.phoneNumber)) {
            updateErrors.push('Invalid phone number format');
        }
        if (updateMemberDto.email && !MemberValidationUtil.isValidEmail(updateMemberDto.email)) {
            updateErrors.push('Invalid email format');
        }
        if (updateMemberDto.aadharNumber && !MemberValidationUtil.isValidAadhar(updateMemberDto.aadharNumber)) {
            updateErrors.push('Invalid Aadhar number format');
        }
        if (updateMemberDto.panNumber && !MemberValidationUtil.isValidPAN(updateMemberDto.panNumber)) {
            updateErrors.push('Invalid PAN number format');
        }
        if (updateErrors.length > 0) {
            throw new BadRequestException(updateErrors);
        }

        // --- Business Rules Validation (Updates) ---
        // RULE_MEMBER_MIN_AGE/MAX_AGE/MIN_SHARE_AMT aren't seeded in system_configs
        // (confirmed: POST /members hits this same "Configuration not found" error
        // unconditionally, unrelated to this fix) — default rather than throw, same
        // .catch() pattern already used for RULE_MEMBER_ENTRY_FEE in saveMemberMaster().
        if (updateMemberDto.dateOfBirth) {
            const minAge = await this.systemConfigService.getConfigValue('RULE_MEMBER_MIN_AGE').catch(() => 18);
            const maxAge = await this.systemConfigService.getConfigValue('RULE_MEMBER_MAX_AGE').catch(() => 100);
            if (!MemberValidationUtil.isValidAge(new Date(updateMemberDto.dateOfBirth), minAge, maxAge)) {
                throw new BadRequestException(`Member age must be between ${minAge} and ${maxAge} years`);
            }
        }

        if (updateMemberDto.shareAmount !== undefined) {
            const minShareAmt = await this.systemConfigService.getConfigValue('RULE_MEMBER_MIN_SHARE_AMT').catch(() => 0);
            if (updateMemberDto.shareAmount < minShareAmt) {
                throw new BadRequestException(`Minimum share capital required is ₹${minShareAmt}`);
            }
        }
        // -------------------------------------------

        // Format phone number if provided
        if (updateMemberDto.phoneNumber) {
            updateMemberDto.phoneNumber = MemberValidationUtil.formatPhoneNumber(
                updateMemberDto.phoneNumber,
            );
        }

        // Check for duplicate phone number (excluding current member)
        if (updateMemberDto.phoneNumber && updateMemberDto.phoneNumber !== member.phoneno) {
            const dup = await this.dataSource.query(
                `SELECT mbno FROM member_master WHERE phoneno = $1 AND mbno != $2 LIMIT 1`,
                [updateMemberDto.phoneNumber, id],
            );
            if (dup.length > 0) {
                throw new ConflictException('Member with this phone number already exists');
            }
        }

        // Check for duplicate email (excluding current member)
        if (updateMemberDto.email && updateMemberDto.email !== member.email) {
            const dup = await this.dataSource.query(
                `SELECT mbno FROM member_master WHERE email = $1 AND mbno != $2 LIMIT 1`,
                [updateMemberDto.email, id],
            );
            if (dup.length > 0) {
                throw new ConflictException('Member with this email already exists');
            }
        }

        const fieldToColumn: Record<string, string> = {
            firstName: 'f_name', lastName: 'l_name', dateOfBirth: 'dob', address: 'present_address',
            phoneNumber: 'phoneno', email: 'email', aadharNumber: 'aadharno', panNumber: 'pan_no',
            occupation: 'desig', shareAmount: 'share_amount',
        };
        const sets: string[] = [];
        const params: any[] = [id];
        for (const [dtoKey, column] of Object.entries(fieldToColumn)) {
            const value = (updateMemberDto as any)[dtoKey];
            if (value === undefined) continue;
            params.push(value);
            sets.push(`${column} = $${params.length}`);
        }
        if (updateMemberDto.status) {
            params.push(updateMemberDto.status === 'ACTIVE' ? 'Y' : 'N');
            sets.push(`isactive = $${params.length}`);
        }

        if (sets.length === 0) {
            return this.mapMemberMasterToResponseDto(member);
        }

        // TypeORM quirk (same as C-3): dataSource.query() returns [rows, rowCount]
        // for UPDATE, not rows directly.
        const [updatedRows] = await this.dataSource.query(
            `UPDATE member_master SET ${sets.join(', ')} WHERE mbno = $1 RETURNING ${MemberCrudService.MEMBER_MASTER_COLUMNS}`,
            params,
        );
        if (!updatedRows || updatedRows.length === 0) {
            throw new NotFoundException(`Member with ID ${id} not found`);
        }

        return this.mapMemberMasterToResponseDto(updatedRows[0]);
    }

    /**
     * Update only a member's lifecycle status (ACTIVE / INACTIVE / RESIGNED / ...).
     * member_master has only a Y/N isactive flag — no separate SUSPENDED state and
     * no note column, so anything other than ACTIVE collapses to 'N' and `reason`
     * is logged only (matches the existing limitation documented on getStatistics()).
     */
    async updateStatus(id: number, status: string, reason?: string): Promise<MemberResponseDto> {
        const [updatedRows] = await this.dataSource.query(
            `UPDATE member_master SET isactive = $2 WHERE mbno = $1 RETURNING ${MemberCrudService.MEMBER_MASTER_COLUMNS}`,
            [id, status === 'ACTIVE' ? 'Y' : 'N'],
        );
        if (!updatedRows || updatedRows.length === 0) {
            throw new NotFoundException(`Member with ID ${id} not found`);
        }

        this.logger.log(
            `Member ${id} status changed -> ${status}` +
            (reason ? ` (reason: ${reason})` : ''),
        );

        return this.mapMemberMasterToResponseDto(updatedRows[0]);
    }

    /**
     * Delete member
     */
    async remove(id: number): Promise<void> {
        // Dependency guard: with findOne/update pointed at member_master (4.2 fix),
        // this DELETE started actually working for the first time — and immediately
        // deleted a real member (610000036) that two loan_pending rows referenced,
        // orphaning them. member_master had no dependency check at all. Scaffolding
        // rows every member gets on creation (fundsmaster/membercategory/
        // member_balances) are deliberately excluded — only active product/account
        // relationships block deletion. `ledger` is also excluded: every member gets
        // an entry-fee ledger row at admission, so including it would block deleting
        // any properly-created member — a ledger row is historical audit trail, not
        // a live relationship like an open loan or deposit account.
        const dependents: { table: string; column: string }[] = [
            { table: 'loan_pending', column: 'mbno' },
            { table: 'loan_master', column: 'mbno' },
            { table: 'sbmaster', column: 'mbno' },
            { table: 'fdmaster', column: 'mbno' },
            { table: 'rdmaster', column: 'mbno' },
            { table: 'suretymaster', column: 'mbno' },
        ];
        for (const { table, column } of dependents) {
            const rows = await this.dataSource.query(
                `SELECT 1 FROM ${table} WHERE ${column} = $1 LIMIT 1`,
                [id],
            );
            if (rows.length > 0) {
                throw new ConflictException(
                    `Cannot delete member ${id} — has records in ${table}. Remove or transfer those first.`,
                );
            }
        }

        const [deletedRows] = await this.dataSource.query(
            `DELETE FROM member_master WHERE mbno = $1 RETURNING mbno`,
            [id],
        );
        if (!deletedRows || deletedRows.length === 0) {
            throw new NotFoundException(`Member with ID ${id} not found`);
        }
    }

    /**
     * Server-side mirror of MemberMaster.tsx's validateForm() — same rules, same regexes,
     * same ranges, applied to the raw member_master field names saveMemberMaster receives.
     * Every check here is optional-if-empty (matching the frontend), except firstName which
     * is genuinely required.
     */
    private validateMemberMasterData(d: any): string[] {
        const errors: string[] = [];

        const fn = (d.f_name || '').trim();
        if (!fn) errors.push('First Name is required');
        else if (fn.length < 2 || fn.length > 50) errors.push('First Name must be 2-50 characters');
        else if (!/^[A-Za-z\s.]+$/.test(fn)) errors.push('First Name: letters and spaces only');

        const ln = (d.l_name || '').trim();
        if (ln && (ln.length < 2 || ln.length > 50)) errors.push('Last Name must be 2-50 characters');
        if (ln && !/^[A-Za-z\s.]+$/.test(ln)) errors.push('Last Name: letters and spaces only');

        const age = Number(d.age);
        if (d.age !== undefined && d.age !== null && d.age !== '' && (isNaN(age) || age < 0 || age > 99)) {
            errors.push('Age must be between 0 and 99');
        }

        const aadhar = (d.aadharno || '').trim();
        if (aadhar && !/^\d{12}$/.test(aadhar)) errors.push('Aadhar No must be exactly 12 digits');

        const pan = (d.pan_no || '').trim();
        if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) errors.push('PAN must be 10 chars: 5 letters + 4 digits + 1 letter (e.g. ABCDE1234F)');

        const mobile = (d.phoneno || '').trim();
        if (mobile && !/^[6-9]\d{9}$/.test(mobile)) errors.push('Mobile must be 10 digits starting with 6-9');

        const email = (d.email || '').trim();
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Invalid email format');

        if (d.dob) {
            const dob = new Date(d.dob);
            if (dob > new Date()) errors.push('Date of Birth cannot be in the future');
            if (d.dor && new Date(d.dor) <= dob) errors.push('Retirement Date must be after Date of Birth');
        }

        if (d.flg_insured === 'Y') {
            const insAmt = Number(d.insureamt);
            if (!insAmt || insAmt <= 0) errors.push('Insurance amount required when insured');
            if (insAmt > 99999) errors.push('Insurance amount max ₹99,999');
        }

        const numChecks: [any, string, number, number][] = [
            [d.basic_pay, 'Basic Pay', 0, 9999999],
            [d.share_amount, 'Share Amount', 0, 9999999],
            [d.gross_salary, 'Monthly Contribution', 0, 99999],
            [d.compulsory_deposit, 'Compulsory Deposit', 0, 99999],
        ];
        for (const [raw, label, min, max] of numChecks) {
            if (raw === undefined || raw === null || raw === '') continue;
            const val = Number(raw);
            if (isNaN(val)) errors.push(`${label} must be a valid number`);
            else if (val < min) errors.push(`${label} cannot be negative`);
            else if (val > max) errors.push(`${label} max ₹${max.toLocaleString('en-IN')}`);
        }

        if ((d.pfno || '').length > 10) errors.push('Sr.No/EPF/P.NO max 10 characters');
        if ((d.frs_no || '').length > 20) errors.push('F.R.S. Number max 20 characters');
        if ((d.branchmsno || '').length > 50) errors.push('Branch MS No max 50 characters');
        if ((d.dept_name || '').length > 50) errors.push('Department max 50 characters');

        return errors;
    }

    /**
     * Save or update member master (legacy table support)
     */
    async saveMemberMaster(memberData: any, username: string = 'system') {
        try {
            // BUG FIX 17: saveMemberMaster only ever checked for duplicate values — every other
            // rule (age range, PAN/Aadhar/email/mobile format, DOB not in the future, numeric
            // ranges, field lengths) existed only in the frontend's validateForm(). Any direct
            // API caller bypassed all of it; confirmed live with negative age, malformed PAN,
            // a 5-digit Aadhar, an invalid email, negative share amount, a 2099 DOB, and an
            // empty first name all being accepted and written to member_master. Mirrors the
            // frontend's rules exactly (same regexes/ranges) so both layers agree.
            const validationErrors = this.validateMemberMasterData(memberData);
            if (validationErrors.length > 0) {
                throw new BadRequestException(validationErrors);
            }

            const currentMbno = (memberData.mbno && memberData.mbno !== 'auto') ? memberData.mbno : null;

            // Duplicate checks for fields that must be unique across all members.
            // On UPDATE, exclude the current member (currentMbno). On INSERT, currentMbno is null so all rows are checked.
            const uniqueChecks: { field: string; column: string; label: string }[] = [
                { field: 'pfno',    column: 'pfno',    label: 'P.NO / PF No' },
                { field: 'aadharno', column: 'aadharno', label: 'Aadhar No' },
                { field: 'pan_no',  column: 'pan_no',  label: 'PAN Card No' },
                { field: 'frs_no',  column: 'frs_no',  label: 'FRS Number' },
                { field: 'phoneno', column: 'phoneno', label: 'Phone Number' },
                { field: 'email',   column: 'email',   label: 'Email' },
            ];

            for (const { field, column, label } of uniqueChecks) {
                const value = (memberData[field] || '').trim();
                if (!value) continue;

                const rows = currentMbno
                    ? await this.dataSource.query(
                        `SELECT mbno FROM member_master WHERE ${column} = $1 AND mbno != $2 LIMIT 1`,
                        [value, currentMbno]
                      )
                    : await this.dataSource.query(
                        `SELECT mbno FROM member_master WHERE ${column} = $1 LIMIT 1`,
                        [value]
                      );

                if (rows.length > 0) {
                    throw new ConflictException(
                        `${label} '${value}' is already registered under member no. ${rows[0].mbno}`
                    );
                }
            }

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
            supanuationdate = $35, compulsory_deposit = $36, share_amount = $37, cast_category = $38,
            email = $39
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
                    memberData.share_amount || 0, memberData.cast_category || '',
                    memberData.email || ''
                ]);

                // C-3 fix: an mbno that doesn't match any row made this UPDATE a silent
                // no-op — the query still "succeeds" with 0 rows affected, and the old
                // code returned result[0] regardless, reporting 201 success for a save
                // that touched nothing. Confirmed live with a non-existent mbno:
                // {"success":true,"statusCode":201,"data":[]} while member_master was
                // untouched. Creation (the `mbno === 'auto'` branch below) was already
                // correct — only this update path needs the check.
                //
                // TypeORM quirk: dataSource.query() returns rows directly for INSERT,
                // but [rows, rowCount] for UPDATE/DELETE — result[0] here is the rows
                // array itself, not a row, so an unmatched update returns `[]`.
                const [updatedRows] = result;
                if (!updatedRows || updatedRows.length === 0) {
                    throw new NotFoundException(`Member ${memberData.mbno} not found — cannot update`);
                }

                // Return raw row — TransformInterceptor handles the { success, data } envelope
                return updatedRows[0];
            } else {
                // Insert new member - derive branch code from branchmsno (e.g. "1-BHILAI-BHILAI-61" → "61")
                const branchParts = (memberData.branchmsno || '').split('-');
                const branchCode = branchParts.length >= 2 ? branchParts[branchParts.length - 1].trim() : '61';
                const memberNumber = await this.sequenceGenerator.generateNextMemberNumber(branchCode);
                const entryFee = await this.systemConfigService.getConfigValue('RULE_MEMBER_ENTRY_FEE').catch(() => 5);

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
            supanuationdate, compulsory_deposit, share_amount, cast_category, email
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
            $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
            $25, $26, $27, $28, $29, $30,
            $31, $32, $33, $34, $35, $36,
            $37, $38, $39, $40, $41
          )
          RETURNING *
        `;

                const queryRunner = this.dataSource.createQueryRunner();
                await queryRunner.connect();
                await queryRunner.startTransaction();

                try {
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
                        memberData.share_amount || 0, memberData.cast_category || '', memberData.email || ''
                    ]);

                    // Initialize fundsmaster row (legacy: cdamt = compulsory_deposit, rest = 0)
                    await queryRunner.query(
                        `INSERT INTO fundsmaster (mbno, mdamt, cdamt, shareamt, mdopbal, shareopbal, cdopbal, lnexecrec, suspbal)
                         VALUES ($1, 0, $2, $3, 0, 0, 0, 0, 0)
                         ON CONFLICT DO NOTHING`,
                        [memberNumber, memberData.compulsory_deposit || 0, memberData.share_amount || 0]
                    );

                    // Initialize membercategory row (legacy: categoryCode from cast_category, memberType).
                    // categoryCode is looked up from castcategorymaster (the Cast Category Master
                    // screen's table) instead of a hardcoded map, so the two stay in sync — falls
                    // back to 1 only when the member's category has no matching master row.
                    const memberTypeMap: Record<string, number> = { 'Regular': 1, 'Associate': 2, 'Honorary': 3 };
                    const castCategoryRow = memberData.cast_category
                        ? await queryRunner.query(
                            `SELECT id FROM castcategorymaster WHERE LOWER(TRIM(castcategory)) = LOWER(TRIM($1)) LIMIT 1`,
                            [memberData.cast_category]
                        )
                        : [];
                    const categoryCode = castCategoryRow?.[0]?.id ?? 1;
                    const memberType = memberTypeMap[memberData.member_type] || 1;
                    await queryRunner.query(
                        `INSERT INTO membercategory (mbno, categorycode, membertype)
                         VALUES ($1, $2, $3)
                         ON CONFLICT DO NOTHING`,
                        [memberNumber, categoryCode, memberType]
                    );

                    // Initialize member_balances row. Every screen that reports a
                    // member's outstanding loan/share position LEFT JOINs this table
                    // and COALESCEs the result to 0 — so a missing row does not read
                    // as "unknown", it reads as a confident ₹0. That is how the Loan
                    // Sanction screen came to show no existing debt for members
                    // carrying lakhs. The row must exist from admission onward.
                    const balanceName = [memberData.f_name, memberData.m_name, memberData.l_name]
                        .filter(Boolean).join(' ').trim();
                    await queryRunner.query(
                        `INSERT INTO member_balances (
                            mbno, pfno, member_name, officeno, dr_cr, shares, compulsory_deposit,
                            rd_amt, regularloan, regularinstallamt, int_amount,
                            emergency_loan_balance, einstallamt, eint_amount, frsbalance
                         ) VALUES ($1, $2, $3, $4, 0, $5, $6, 0, 0, 0, 0, 0, 0, 0, 0)
                         ON CONFLICT DO NOTHING`,
                        [
                            memberNumber, Number(memberData.pfno) || 0, balanceName,
                            Number(memberData.officeno) || 0,
                            memberData.share_amount || 0, memberData.compulsory_deposit || 0,
                        ]
                    );

                    // Entry Fee receipt (CR I1001 / DR A1001) — same pattern legacy staff used
                    // to manually key in on member admission (see UtilitiesService.saveReceipt).
                    if (entryFee > 0) {
                        const ledgerMax = await queryRunner.query(
                            `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no, COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
                        );
                        let nextTransNo = Number(ledgerMax[0]?.next_trans_no ?? 1);
                        let nextLedgerId = Number(ledgerMax[0]?.next_ledger_id ?? 1);
                        const feeVoucherNo = await generateVoucherNo(queryRunner, 'R');
                        const admissionDate = memberData.memb_date || new Date();

                        const accTypeRows = await queryRunner.query(
                            `SELECT acc_type FROM ledger WHERE code = 'I1001' AND acc_type IS NOT NULL AND acc_type <> ''
                             GROUP BY acc_type ORDER BY COUNT(*) DESC LIMIT 1`
                        );
                        const feeAccType = accTypeRows[0]?.acc_type || 'OTH';

                        await queryRunner.query(
                            `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                             VALUES ($1, $2, 'CR', 'I1001', $3, 0, $4, $5, $6, 'R', 'C', 0, $7, $8, $9)`,
                            [nextTransNo++, admissionDate, memberNumber, feeAccType, entryFee, feeVoucherNo, 'Entry Fee', username, nextLedgerId++]
                        );
                        await queryRunner.query(
                            `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                             VALUES ($1, $2, 'DR', 'A1001', $3, 0, 'CINH', $4, $5, 'P', 'C', 0, $6, $7, $8)`,
                            [nextTransNo++, admissionDate, memberNumber, entryFee, feeVoucherNo, 'Entry Fee', username, nextLedgerId++]
                        );
                    }

                    await queryRunner.commitTransaction();
                    return result[0];
                } catch (txError) {
                    await queryRunner.rollbackTransaction();
                    throw txError;
                } finally {
                    await queryRunner.release();
                }
            }
        } catch (error) {
            this.logger.error(`Error saving member master: ${error.message}`);
            throw error;
        }
    }
}
