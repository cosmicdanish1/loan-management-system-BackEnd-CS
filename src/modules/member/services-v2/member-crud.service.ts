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
     * Update only a member's lifecycle status (ACTIVE / INACTIVE / RESIGNED / ...).
     * A focused, safe alternative to a full update — does not touch balances or
     * any financial data. `reason` is accepted for audit but the member table has
     * no note column, so it is logged only.
     */
    async updateStatus(id: number, status: string, reason?: string): Promise<MemberResponseDto> {
        const member = await this.memberRepository.findOne({ where: { id } });

        if (!member) {
            throw new NotFoundException(`Member with ID ${id} not found`);
        }

        const previous = member.status;
        member.status = status;
        const updatedMember = await this.memberRepository.save(member);

        this.logger.log(
            `Member ${id} status changed ${previous} -> ${status}` +
            (reason ? ` (reason: ${reason})` : ''),
        );

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

                // Return raw row — TransformInterceptor handles the { success, data } envelope
                return result[0];
            } else {
                // Insert new member - derive branch code from branchmsno (e.g. "1-BHILAI-BHILAI-61" → "61")
                const branchParts = (memberData.branchmsno || '').split('-');
                const branchCode = branchParts.length >= 2 ? branchParts[branchParts.length - 1].trim() : '61';
                const memberNumber = await this.sequenceGenerator.generateNextMemberNumber(branchCode);

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

                    // Initialize membercategory row (legacy: categoryCode from cast_category, memberType)
                    const castMap: Record<string, number> = { 'OBC': 1, 'General': 2, 'SC': 3, 'ST': 4 };
                    const memberTypeMap: Record<string, number> = { 'Regular': 1, 'Associate': 2, 'Honorary': 3 };
                    const categoryCode = castMap[memberData.cast_category] || 1;
                    const memberType = memberTypeMap[memberData.member_type] || 1;
                    await queryRunner.query(
                        `INSERT INTO membercategory (mbno, categorycode, membertype)
                         VALUES ($1, $2, $3)
                         ON CONFLICT DO NOTHING`,
                        [memberNumber, categoryCode, memberType]
                    );

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
