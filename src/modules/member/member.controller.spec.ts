import { Test, TestingModule } from '@nestjs/testing';
import { MemberController } from './member.controller';
import { MemberService } from './member.service';
import { SignatureService } from './services/signature.service';
import { CreateMemberDto, UpdateMemberDto, SearchMemberDto, MemberResponseDto } from './dto';
import { NotFoundException, ConflictException } from '@nestjs/common';

describe('MemberController', () => {
  let controller: MemberController;
  let memberService: MemberService;
  let signatureService: SignatureService;

  const mockMemberService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    findByMemberNumber: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    restore: jest.fn(),
    getStatistics: jest.fn(),
  };

  const mockSignatureService = {
    uploadSignature: jest.fn(),
    getSignature: jest.fn(),
    deleteSignature: jest.fn(),
    getSignatureStatistics: jest.fn(),
  };

  const mockMemberResponse: MemberResponseDto = {
    id: 1,
    memberNumber: 'MEM000001',
    firstName: 'John',
    lastName: 'Doe',
    fullName: 'John Doe',
    dateOfBirth: new Date('1990-01-15'),
    address: '123 Main Street',
    phoneNumber: '919876543210',
    email: 'john.doe@example.com',
    shareAmount: 1000,
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MemberController],
      providers: [
        {
          provide: MemberService,
          useValue: mockMemberService,
        },
        {
          provide: SignatureService,
          useValue: mockSignatureService,
        },
      ],
    }).compile();

    controller = module.get<MemberController>(MemberController);
    memberService = module.get<MemberService>(MemberService);
    signatureService = module.get<SignatureService>(SignatureService);

    // Reset all mocks
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
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
      mockMemberService.create.mockResolvedValue(mockMemberResponse);

      const result = await controller.create(createMemberDto);

      expect(result).toBe(mockMemberResponse);
      expect(mockMemberService.create).toHaveBeenCalledWith(createMemberDto);
    });

    it('should handle ConflictException', async () => {
      mockMemberService.create.mockRejectedValue(
        new ConflictException('Member with this phone number already exists'),
      );

      await expect(controller.create(createMemberDto)).rejects.toThrow(ConflictException);
    });
  });

  describe('findAll', () => {
    it('should return paginated members', async () => {
      const searchDto: SearchMemberDto = {
        page: 1,
        limit: 10,
      };

      const mockResponse = {
        members: [mockMemberResponse],
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
      };

      mockMemberService.findAll.mockResolvedValue(mockResponse);

      const result = await controller.findAll(searchDto);

      expect(result).toBe(mockResponse);
      expect(mockMemberService.findAll).toHaveBeenCalledWith(searchDto);
    });

    it('should handle search with filters', async () => {
      const searchDto: SearchMemberDto = {
        firstName: 'John',
        status: 'ACTIVE',
        page: 1,
        limit: 10,
      };

      const mockResponse = {
        members: [mockMemberResponse],
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
      };

      mockMemberService.findAll.mockResolvedValue(mockResponse);

      const result = await controller.findAll(searchDto);

      expect(result).toBe(mockResponse);
      expect(mockMemberService.findAll).toHaveBeenCalledWith(searchDto);
    });
  });

  describe('findOne', () => {
    it('should return a member by ID', async () => {
      mockMemberService.findOne.mockResolvedValue(mockMemberResponse);

      const result = await controller.findOne(1);

      expect(result).toBe(mockMemberResponse);
      expect(mockMemberService.findOne).toHaveBeenCalledWith(1);
    });

    it('should handle NotFoundException', async () => {
      mockMemberService.findOne.mockRejectedValue(
        new NotFoundException('Member with ID 999 not found'),
      );

      await expect(controller.findOne(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('findByMemberNumber', () => {
    it('should return a member by member number', async () => {
      mockMemberService.findByMemberNumber.mockResolvedValue(mockMemberResponse);

      const result = await controller.findByMemberNumber('MEM000001');

      expect(result).toBe(mockMemberResponse);
      expect(mockMemberService.findByMemberNumber).toHaveBeenCalledWith('MEM000001');
    });

    it('should handle NotFoundException', async () => {
      mockMemberService.findByMemberNumber.mockRejectedValue(
        new NotFoundException('Member with number MEM999999 not found'),
      );

      await expect(controller.findByMemberNumber('MEM999999')).rejects.toThrow(
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
      const updatedMember = {
        ...mockMemberResponse,
        firstName: 'Jane',
        email: 'jane.doe@example.com',
      };

      mockMemberService.update.mockResolvedValue(updatedMember);

      const result = await controller.update(1, updateMemberDto);

      expect(result).toBe(updatedMember);
      expect(mockMemberService.update).toHaveBeenCalledWith(1, updateMemberDto);
    });

    it('should handle NotFoundException', async () => {
      mockMemberService.update.mockRejectedValue(
        new NotFoundException('Member with ID 999 not found'),
      );

      await expect(controller.update(999, updateMemberDto)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('should soft delete a member', async () => {
      mockMemberService.remove.mockResolvedValue(undefined);

      await controller.remove(1);

      expect(mockMemberService.remove).toHaveBeenCalledWith(1);
    });

    it('should handle NotFoundException', async () => {
      mockMemberService.remove.mockRejectedValue(
        new NotFoundException('Member with ID 999 not found'),
      );

      await expect(controller.remove(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('restore', () => {
    it('should restore a soft deleted member', async () => {
      mockMemberService.restore.mockResolvedValue(mockMemberResponse);

      const result = await controller.restore(1);

      expect(result).toBe(mockMemberResponse);
      expect(mockMemberService.restore).toHaveBeenCalledWith(1);
    });

    it('should handle NotFoundException', async () => {
      mockMemberService.restore.mockRejectedValue(
        new NotFoundException('Member with ID 999 not found'),
      );

      await expect(controller.restore(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getStatistics', () => {
    it('should return member statistics', async () => {
      const mockStats = {
        totalMembers: 100,
        activeMembers: 80,
        inactiveMembers: 15,
        suspendedMembers: 5,
        totalShareAmount: 50000,
      };

      mockMemberService.getStatistics.mockResolvedValue(mockStats);

      const result = await controller.getStatistics();

      expect(result).toBe(mockStats);
      expect(mockMemberService.getStatistics).toHaveBeenCalled();
    });
  });

  describe('signature endpoints', () => {
    const mockFile: Express.Multer.File = {
      fieldname: 'signature',
      originalname: 'test-signature.jpg',
      encoding: '7bit',
      mimetype: 'image/jpeg',
      size: 1024 * 1024,
      buffer: Buffer.from('fake-image-data'),
      destination: '',
      filename: '',
      path: '',
      stream: null as any,
    };

    describe('uploadSignature', () => {
      it('should upload signature successfully', async () => {
        const mockResponse = {
          signatureUrl: '/api/v1/members/1/signature',
        };

        mockSignatureService.uploadSignature.mockResolvedValue(mockResponse);

        const result = await controller.uploadSignature(1, mockFile);

        expect(result).toBe(mockResponse);
        expect(mockSignatureService.uploadSignature).toHaveBeenCalledWith(1, mockFile);
      });
    });

    describe('getSignature', () => {
      it('should return signature file info', async () => {
        const mockSignatureInfo = {
          filePath: 'uploads/signatures/member_1_signature.jpg',
          mimeType: 'image/jpeg',
        };

        mockSignatureService.getSignature.mockResolvedValue(mockSignatureInfo);

        // Mock response object
        const mockResponse = {
          set: jest.fn(),
        };

        await controller.getSignature(1, mockResponse as any);

        expect(mockSignatureService.getSignature).toHaveBeenCalledWith(1);
        expect(mockResponse.set).toHaveBeenCalledWith({
          'Content-Type': 'image/jpeg',
          'Content-Disposition': 'inline; filename="member_1_signature"',
        });
      });
    });

    describe('deleteSignature', () => {
      it('should delete signature successfully', async () => {
        mockSignatureService.deleteSignature.mockResolvedValue(undefined);

        await controller.deleteSignature(1);

        expect(mockSignatureService.deleteSignature).toHaveBeenCalledWith(1);
      });
    });

    describe('getSignatureStatistics', () => {
      it('should return signature statistics', async () => {
        const mockStats = {
          totalMembers: 100,
          membersWithSignature: 75,
          membersWithoutSignature: 25,
          signaturePercentage: 75,
        };

        mockSignatureService.getSignatureStatistics.mockResolvedValue(mockStats);

        const result = await controller.getSignatureStatistics();

        expect(result).toBe(mockStats);
        expect(mockSignatureService.getSignatureStatistics).toHaveBeenCalled();
      });
    });
  });
});
