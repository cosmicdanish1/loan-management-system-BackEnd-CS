import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, FindOptionsWhere, ILike } from 'typeorm';
import { Member } from './entities/member.entity';
import {
  CreateMemberDto,
  UpdateMemberDto,
  MemberResponseDto,
  SearchMemberDto,
} from './dto';
import { MemberNumberUtil, MemberValidationUtil } from './utils';

@Injectable()
export class MemberService {
  constructor(
    @InjectRepository(Member)
    private readonly memberRepository: Repository<Member>,
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
}
