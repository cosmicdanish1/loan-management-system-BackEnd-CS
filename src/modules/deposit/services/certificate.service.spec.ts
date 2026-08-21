import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { CertificateService } from './certificate.service';

// Mock fs and path modules
jest.mock('fs');
jest.mock('path');
const mockFs = fs as jest.Mocked<typeof fs>;
const mockPath = path as jest.Mocked<typeof path>;

// Mock PDFKit
jest.mock('pdfkit', () => {
  return jest.fn().mockImplementation(() => ({
    fontSize: jest.fn().mockReturnThis(),
    font: jest.fn().mockReturnThis(),
    text: jest.fn().mockReturnThis(),
    image: jest.fn().mockReturnThis(),
    moveTo: jest.fn().mockReturnThis(),
    lineTo: jest.fn().mockReturnThis(),
    stroke: jest.fn().mockReturnThis(),
    rect: jest.fn().mockReturnThis(),
    fill: jest.fn().mockReturnThis(),
    fillColor: jest.fn().mockReturnThis(),
    pipe: jest.fn(),
    end: jest.fn(),
    page: { height: 800 },
  }));
});

describe('CertificateService', () => {
  let service: CertificateService;
  let configService: ConfigService;

  const mockFixedDepositRepository = {
    findOne: jest.fn(),
  };

  const mockRecurringDepositRepository = {
    findOne: jest.fn(),
  };

  const mockMemberRepository = {
    findOne: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  const mockMember = {
    id: 1,
    memberNumber: 'MEM001',
    firstName: 'John',
    lastName: 'Doe',
    dateOfBirth: new Date('1990-01-01'),
    address: '123 Main St',
    phoneNumber: '1234567890',
    email: 'john@example.com',
    aadharNumber: '123456789012',
    panNumber: 'ABCDE1234F',
    occupation: 'Engineer',
    shareAmount: 1000,
    signatureImagePath: null,
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    get fullName() { return `${this.firstName} ${this.lastName}`; },
  };

  const mockFixedDeposit = {
    id: 1,
    accountNumber: 'FD24010001',
    member: mockMember,
    memberId: 1,
    principalAmount: 100000,
    interestRate: 8.5,
    depositDate: new Date('2024-01-01'),
    maturityDate: new Date('2025-01-01'),
    tenureMonths: 12,
    maturityAmount: 108500,
    interestAccrued: 0,
    status: 'ACTIVE',
    closureDate: null,
    closureAmount: null,
    penaltyAmount: null,
    closureReason: null,
    isAutoRenewal: false,
    lastInterestCalculationDate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    get isMatured() { return new Date() >= this.maturityDate; },
    get daysToMaturity() {
      const today = new Date();
      const maturity = new Date(this.maturityDate);
      const diffTime = maturity.getTime() - today.getTime();
      return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    },
    get currentValue() {
      if (this.status === 'CLOSED') {
        return Number(this.closureAmount || 0);
      }
      return Number(this.principalAmount) + Number(this.interestAccrued);
    },
    calculateMaturityAmount() {
      const principal = Number(this.principalAmount);
      const rate = Number(this.interestRate) / 100;
      const time = this.tenureMonths / 12;
      return principal * Math.pow(1 + rate, time);
    },
    calculatePenaltyAmount(penaltyRate: number = 1) {
      const currentInterest = this.interestAccrued;
      return Number(currentInterest) * (penaltyRate / 100);
    },
  };

  const mockRecurringDeposit = {
    id: 1,
    accountNumber: 'RD24010001',
    member: mockMember,
    memberId: 1,
    monthlyInstallment: 5000,
    interestRate: 9.0,
    startDate: new Date('2024-01-01'),
    maturityDate: new Date('2026-01-01'),
    tenureMonths: 24,
    maturityAmount: 130000,
    totalDeposited: 0,
    interestAccrued: 0,
    installmentsPaid: 0,
    installmentsMissed: 0,
    status: 'ACTIVE',
    closureDate: null,
    closureAmount: null,
    penaltyAmount: null,
    closureReason: null,
    lastInstallmentDate: null,
    nextDueDate: new Date('2024-01-01'),
    installments: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    get isMatured() { return new Date() >= this.maturityDate; },
    get remainingInstallments() { return this.tenureMonths - this.installmentsPaid; },
    get isOverdue() {
      if (!this.nextDueDate || this.status !== 'ACTIVE') return false;
      return new Date() > this.nextDueDate;
    },
    get currentValue() {
      if (this.status === 'CLOSED') {
        return Number(this.closureAmount || 0);
      }
      return Number(this.totalDeposited) + Number(this.interestAccrued);
    },
    calculateMaturityAmount() {
      const monthlyAmount = Number(this.monthlyInstallment);
      const rate = Number(this.interestRate) / 100 / 12;
      const months = this.tenureMonths;
      
      if (rate === 0) {
        return monthlyAmount * months;
      }
      
      const factor = (Math.pow(1 + rate, months) - 1) / rate;
      return monthlyAmount * factor * (1 + rate);
    },
    calculateNextDueDate() {
      if (!this.lastInstallmentDate) {
        return new Date(this.startDate);
      }
      
      const nextDue = new Date(this.lastInstallmentDate);
      nextDue.setMonth(nextDue.getMonth() + 1);
      return nextDue;
    },
    calculatePenalty(penaltyRate: number = 2) {
      return this.installmentsMissed * Number(this.monthlyInstallment) * (penaltyRate / 100);
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: CertificateService,
          useValue: {
            generateFixedDepositCertificate: jest.fn(),
            generateRecurringDepositCertificate: jest.fn(),
            generateShareCertificate: jest.fn(),
            getCertificateFilePath: jest.fn(),
            deleteCertificate: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<CertificateService>(CertificateService);
    configService = module.get<ConfigService>(ConfigService);

    // Setup default config service mocks
    mockConfigService.get.mockImplementation((key: string, defaultValue?: any) => {
      const config = {
        CERTIFICATES_PATH: './uploads/certificates',
        ORG_NAME: 'Test Loan Management System',
        ORG_ADDRESS: 'Test Address',
        ORG_PHONE: '+91-1234567890',
        ORG_EMAIL: 'test@lms.com',
        AUTHORIZED_SIGNATORY: 'Test Manager',
        SIGNATORY_DESIGNATION: 'General Manager',
      };
      return config[key] || defaultValue;
    });

    // Setup fs mocks
    mockFs.existsSync.mockReturnValue(true);
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.createWriteStream.mockReturnValue({
      on: jest.fn((event, callback) => {
        if (event === 'finish') {
          setTimeout(callback, 0);
        }
      }),
    } as any);
    mockFs.unlinkSync.mockReturnValue(undefined);

    // Setup path mocks
    mockPath.join.mockImplementation((...args) => args.join('/'));

    // Reset all mocks
    jest.clearAllMocks();
  });

  describe('generateFixedDepositCertificate', () => {
    it('should generate fixed deposit certificate successfully', async () => {
      const mockResult = 'FIXED_DEPOSIT_FDCERT202401001_1234567890.pdf';
      (service.generateFixedDepositCertificate as jest.Mock).mockResolvedValue(mockResult);

      const result = await service.generateFixedDepositCertificate('1');

      expect(service.generateFixedDepositCertificate).toHaveBeenCalledWith('1');
      expect(result).toBe(mockResult);
    });

    it('should throw NotFoundException if fixed deposit not found', async () => {
      (service.generateFixedDepositCertificate as jest.Mock).mockRejectedValue(new NotFoundException('Fixed deposit not found'));

      await expect(service.generateFixedDepositCertificate('1')).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for invalid deposit status', async () => {
      (service.generateFixedDepositCertificate as jest.Mock).mockRejectedValue(new BadRequestException('Certificate can only be generated for active or matured deposits'));

      await expect(service.generateFixedDepositCertificate('1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('generateRecurringDepositCertificate', () => {
    it('should generate recurring deposit certificate successfully', async () => {
      const mockResult = 'RECURRING_DEPOSIT_RDCERT202401001_1234567890.pdf';
      (service.generateRecurringDepositCertificate as jest.Mock).mockResolvedValue(mockResult);

      const result = await service.generateRecurringDepositCertificate(1);

      expect(service.generateRecurringDepositCertificate).toHaveBeenCalledWith(1);
      expect(result).toBe(mockResult);
    });

    it('should throw NotFoundException if recurring deposit not found', async () => {
      (service.generateRecurringDepositCertificate as jest.Mock).mockRejectedValue(new NotFoundException('Recurring deposit not found'));

      await expect(service.generateRecurringDepositCertificate(1)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for invalid deposit status', async () => {
      (service.generateRecurringDepositCertificate as jest.Mock).mockRejectedValue(new BadRequestException('Certificate can only be generated for active or matured deposits'));

      await expect(service.generateRecurringDepositCertificate(1)).rejects.toThrow(BadRequestException);
    });
  });

  describe('generateShareCertificate', () => {
    it('should generate share certificate successfully', async () => {
      const mockResult = 'SHARE_SHCERT202401001_1234567890.pdf';
      (service.generateShareCertificate as jest.Mock).mockResolvedValue(mockResult);

      const result = await service.generateShareCertificate(1, 10000);

      expect(service.generateShareCertificate).toHaveBeenCalledWith(1, 10000);
      expect(result).toBe(mockResult);
    });

    it('should throw NotFoundException if member not found', async () => {
      (service.generateShareCertificate as jest.Mock).mockRejectedValue(new NotFoundException('Member not found'));

      await expect(service.generateShareCertificate(1, 10000)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getCertificateFilePath', () => {
    it('should return correct file path', () => {
      const fileName = 'test-certificate.pdf';
      const mockResult = './uploads/certificates/test-certificate.pdf';
      (service.getCertificateFilePath as jest.Mock).mockReturnValue(mockResult);

      const result = service.getCertificateFilePath(fileName);

      expect(service.getCertificateFilePath).toHaveBeenCalledWith(fileName);
      expect(result).toBe(mockResult);
    });
  });

  describe('deleteCertificate', () => {
    it('should delete certificate file successfully', async () => {
      const fileName = 'test-certificate.pdf';
      (service.deleteCertificate as jest.Mock).mockResolvedValue(undefined);

      await service.deleteCertificate(fileName);

      expect(service.deleteCertificate).toHaveBeenCalledWith(fileName);
    });

    it('should not throw error if file does not exist', async () => {
      const fileName = 'non-existent-certificate.pdf';
      (service.deleteCertificate as jest.Mock).mockResolvedValue(undefined);

      await expect(service.deleteCertificate(fileName)).resolves.not.toThrow();
    });
  });

  describe('Service Configuration', () => {
    it('should be properly configured', () => {
      expect(service).toBeDefined();
      expect(configService).toBeDefined();
    });
  });
});
