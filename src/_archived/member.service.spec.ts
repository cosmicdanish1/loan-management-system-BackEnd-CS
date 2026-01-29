import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { MemberService } from './member.service';
import { Member } from './entities/member.entity';
import { CreateMemberDto, UpdateMemberDto, SearchMemberDto } from './dto';

describe('MemberService', () => {
  let service: MemberService;
  let repository: Repository<Member>;

  const mockRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
    restore: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockQueryBuilder = {
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn(),
    select: jest.fn().mockReturnThis(),
    getRawOne: jest.fn(),
    where: jest.fn().mockReturnThis(),
    getCount: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemberService,
        {
          provide: getRepositoryToken(Member),
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<MemberService>(MemberService);
    repository = module.get<Repository<Member>>(getRepositoryToken(Member));

    // Reset all mocks
    jest.clearAllMocks();
    mockRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const createMemberDto: CreateMemberDto = {
      firstName: 'John',
      lastName: 'Doe',
      dateOfBirth: '1990-01-15',
      address: '123 Main Street',
      phoneNumber: '9876543210',
      email: 'john.doe@example.com',
    };

    it('should create a member successfully', async () => {
      const mockMember = {
        id: 1,
        memberNumber: 'MEM000001',
        ...createMemberDto,
        dateOfBirth: new Date('1990-01-15'),
        phoneNumber: '919876543210',
        shareAmount: 0,
        status: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockRepository.findOne.mockResolvedValue(null); // No existing members
      mockRepository.create.mockReturnValue(mockMember);
      mockRepository.save.mockResolvedValue(mockMember);

      const result = await service.create(createMemberDto);

      expect(result).toBeDefined();
      expect(result.firstName).toBe(createMemberDto.firstName);
      expect(result.lastName).toBe(createMemberDto.lastName);
      expect(mockRepository.save).toHaveBeenCalled();
    });

    it('should throw ConflictException for duplicate phone number', async () => {
      const existingMember = { id: 1, phoneNumber: '919876543210' };
      mockRepository.findOne.mockResolvedValue(existingMember);

      await expect(service.create(createMemberDto)).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException for duplicate email', async () => {
      const existingMember = { id: 1, email: 'john.doe@example.com' };
      mockRepository.findOne
        .mockResolvedValueOnce(null) // No phone duplicate
        .mockResolvedValueOnce(existingMember); // Email duplicate

      await expect(service.create(createMemberDto)).rejects.toThrow(ConflictException);
    });
  });

  describe('findAll', () => {
    it('should return paginated members', async () => {
      const mockMembers = [
        {
          id: 1,
          memberNumber: 'MEM000001',
          firstName: 'John',
          lastName: 'Doe',
        },
      ];

      mockQueryBuilder.getManyAndCount.mockResolvedValue([mockMembers, 1]);

      const searchDto: SearchMemberDto = {
        page: 1,
        limit: 10,
      };

      const result = await service.findAll(searchDto);

      expect(result).toBeDefined();
      expect(result.members).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.totalPages).toBe(1);
    });

    it('should apply search filters', async () => {
      const mockMembers = [];
      mockQueryBuilder.getManyAndCount.mockResolvedValue([mockMembers, 0]);

      const searchDto: SearchMemberDto = {
        firstName: 'John',
        status: 'ACTIVE',
        search: 'test',
      };

      await service.findAll(searchDto);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'member.firstName ILIKE :firstName',
        { firstName: '%John%' },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'member.status = :status',
        { status: 'ACTIVE' },
      );
    });
  });

  describe('findOne', () => {
    it('should return a member by ID', async () => {
      const mockMember = {
        id: 1,
        memberNumber: 'MEM000001',
        firstName: 'John',
        lastName: 'Doe',
      };

      mockRepository.findOne.mockResolvedValue(mockMember);

      const result = await service.findOne(1);

      expect(result).toBeDefined();
      expect(result.id).toBe(1);
      expect(mockRepository.findOne).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('should throw NotFoundException for non-existent member', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('findByMemberNumber', () => {
    it('should return a member by member number', async () => {
      const mockMember = {
        id: 1,
        memberNumber: 'MEM000001',
        firstName: 'John',
        lastName: 'Doe',
      };

      mockRepository.findOne.mockResolvedValue(mockMember);

      const result = await service.findByMemberNumber('MEM000001');

      expect(result).toBeDefined();
      expect(result.memberNumber).toBe('MEM000001');
      expect(mockRepository.findOne).toHaveBeenCalledWith({
        where: { memberNumber: 'MEM000001' },
      });
    });

    it('should throw NotFoundException for non-existent member number', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(service.findByMemberNumber('MEM999999')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    const updateMemberDto: UpdateMemberDto = {
      firstName: 'Jane',
      email: 'jane.doe@example.com',
    };

    it('should update a member successfully', async () => {
      const existingMember = {
        id: 1,
        memberNumber: 'MEM000001',
        firstName: 'John',
        lastName: 'Doe',
        dateOfBirth: new Date('1990-01-15'),
        address: '123 Main Street',
        phoneNumber: '919876543210',
        email: 'john.doe@example.com',
      };

      const updatedMember = {
        ...existingMember,
        ...updateMemberDto,
      };

      mockRepository.findOne
        .mockResolvedValueOnce(existingMember) // Initial find
        .mockResolvedValueOnce(null) // No email duplicate
        .mockResolvedValueOnce(updatedMember); // Final result

      mockRepository.update.mockResolvedValue({ affected: 1 });

      const result = await service.update(1, updateMemberDto);

      expect(result).toBeDefined();
      expect(result.firstName).toBe('Jane');
      expect(mockRepository.update).toHaveBeenCalledWith(1, updateMemberDto);
    });

    it('should throw NotFoundException for non-existent member', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(service.update(999, updateMemberDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ConflictException for duplicate email during update', async () => {
      const existingMember = {
        id: 1,
        memberNumber: 'MEM000001',
        firstName: 'John',
        lastName: 'Doe',
        dateOfBirth: new Date('1990-01-15'),
        address: '123 Main Street',
        phoneNumber: '919876543210',
        email: 'john.doe@example.com',
      };

      const duplicateEmailMember = {
        id: 2,
        email: 'jane.doe@example.com',
      };

      mockRepository.findOne
        .mockResolvedValueOnce(existingMember) // Initial find
        .mockResolvedValueOnce(duplicateEmailMember); // Email duplicate check

      await expect(service.update(1, updateMemberDto)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('remove', () => {
    it('should soft delete a member', async () => {
      const mockMember = {
        id: 1,
        memberNumber: 'MEM000001',
      };

      mockRepository.findOne.mockResolvedValue(mockMember);
      mockRepository.softDelete.mockResolvedValue({ affected: 1 });

      await service.remove(1);

      expect(mockRepository.softDelete).toHaveBeenCalledWith(1);
    });

    it('should throw NotFoundException for non-existent member', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(service.remove(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('restore', () => {
    it('should restore a soft deleted member', async () => {
      const deletedMember = {
        id: 1,
        memberNumber: 'MEM000001',
        deletedAt: new Date(),
      };

      const restoredMember = {
        ...deletedMember,
        deletedAt: null,
      };

      mockRepository.findOne
        .mockResolvedValueOnce(deletedMember) // Find with deleted
        .mockResolvedValueOnce(restoredMember); // Find after restore

      mockRepository.restore.mockResolvedValue({ affected: 1 });

      const result = await service.restore(1);

      expect(result).toBeDefined();
      expect(mockRepository.restore).toHaveBeenCalledWith(1);
    });

    it('should throw NotFoundException for non-existent member', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(service.restore(999)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for non-deleted member', async () => {
      const activeMember = {
        id: 1,
        memberNumber: 'MEM000001',
        deletedAt: null,
      };

      mockRepository.findOne.mockResolvedValue(activeMember);

      await expect(service.restore(1)).rejects.toThrow(BadRequestException);
    });
  });

  describe('getStatistics', () => {
    it('should return member statistics', async () => {
      mockRepository.count
        .mockResolvedValueOnce(100) // Total members
        .mockResolvedValueOnce(80) // Active members
        .mockResolvedValueOnce(15) // Inactive members
        .mockResolvedValueOnce(5); // Suspended members

      mockQueryBuilder.getRawOne.mockResolvedValue({ total: '50000.00' });

      const result = await service.getStatistics();

      expect(result).toBeDefined();
      expect(result.totalMembers).toBe(100);
      expect(result.activeMembers).toBe(80);
      expect(result.inactiveMembers).toBe(15);
      expect(result.suspendedMembers).toBe(5);
      expect(result.totalShareAmount).toBe(50000);
    });
  });
});
