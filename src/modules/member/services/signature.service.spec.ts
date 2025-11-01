import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SignatureService } from './signature.service';
import { Member } from '../entities/member.entity';

describe('SignatureService', () => {
  let service: SignatureService;
  let repository: Repository<Member>;

  const mockRepository = {
    findOne: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockQueryBuilder = {
    where: jest.fn().mockReturnThis(),
    getCount: jest.fn(),
  };

  const mockFile: Express.Multer.File = {
    fieldname: 'signature',
    originalname: 'test-signature.jpg',
    encoding: '7bit',
    mimetype: 'image/jpeg',
    size: 1024 * 1024, // 1MB
    buffer: Buffer.from('fake-image-data'),
    destination: '',
    filename: '',
    path: '',
    stream: null as any,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SignatureService,
        {
          provide: getRepositoryToken(Member),
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<SignatureService>(SignatureService);
    repository = module.get<Repository<Member>>(getRepositoryToken(Member));

    // Reset all mocks
    jest.clearAllMocks();
    mockRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('file validation', () => {
    it('should throw BadRequestException for no file', async () => {
      await expect(service.uploadSignature(1, null as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for invalid file type', async () => {
      const invalidFile = {
        ...mockFile,
        mimetype: 'text/plain',
      };

      await expect(service.uploadSignature(1, invalidFile)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for file too large', async () => {
      const largeFile = {
        ...mockFile,
        size: 3 * 1024 * 1024, // 3MB
      };

      await expect(service.uploadSignature(1, largeFile)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException for non-existent member', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(service.uploadSignature(999, mockFile)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('member validation', () => {
    it('should throw NotFoundException for non-existent member in getSignature', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(service.getSignature(999)).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException for member without signature', async () => {
      const mockMember = {
        id: 1,
        memberNumber: 'MEM000001',
        signatureImagePath: null,
      };

      mockRepository.findOne.mockResolvedValue(mockMember);

      await expect(service.getSignature(1)).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteSignature', () => {
    it('should throw NotFoundException for non-existent member', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(service.deleteSignature(999)).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException for member without signature', async () => {
      const mockMember = {
        id: 1,
        memberNumber: 'MEM000001',
        signatureImagePath: null,
      };

      mockRepository.findOne.mockResolvedValue(mockMember);

      await expect(service.deleteSignature(1)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getSignatureStatistics', () => {
    it('should return signature statistics', async () => {
      mockRepository.count.mockResolvedValue(100);
      mockQueryBuilder.getCount.mockResolvedValue(75);

      const result = await service.getSignatureStatistics();

      expect(result).toBeDefined();
      expect(result.totalMembers).toBe(100);
      expect(result.membersWithSignature).toBe(75);
      expect(result.membersWithoutSignature).toBe(25);
      expect(result.signaturePercentage).toBe(75);
    });

    it('should handle zero members', async () => {
      mockRepository.count.mockResolvedValue(0);
      mockQueryBuilder.getCount.mockResolvedValue(0);

      const result = await service.getSignatureStatistics();

      expect(result.totalMembers).toBe(0);
      expect(result.membersWithSignature).toBe(0);
      expect(result.membersWithoutSignature).toBe(0);
      expect(result.signaturePercentage).toBe(0);
    });
  });

  describe('processImage', () => {
    it('should process image successfully', async () => {
      const result = await service.processImage(mockFile);

      expect(result).toBe(mockFile.buffer);
    });

    it('should throw BadRequestException for invalid file', async () => {
      const invalidFile = {
        ...mockFile,
        mimetype: 'text/plain',
      };

      await expect(service.processImage(invalidFile)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
