import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'fs';
import { DepositController } from './deposit.controller';
import { DepositService } from './deposit.service';
import { CertificateService } from './services';
import {
  CreateFixedDepositDto,
  UpdateFixedDepositDto,
  CreateRecurringDepositDto,
  DepositClosureDto,
  DepositMaturityDto,
  PayRdInstallmentDto,
} from './dto';

// Mock fs module
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

describe('DepositController', () => {
  let controller: DepositController;
  let depositService: DepositService;
  let certificateService: CertificateService;

  const mockDepositService = {
    createFixedDeposit: jest.fn(),
    findAllFixedDeposits: jest.fn(),
    findFixedDepositById: jest.fn(),
    findFixedDepositsByMember: jest.fn(),
    updateFixedDeposit: jest.fn(),
    closeFixedDeposit: jest.fn(),
    processFixedDepositMaturity: jest.fn(),
    createRecurringDeposit: jest.fn(),
    findAllRecurringDeposits: jest.fn(),
    findRecurringDepositById: jest.fn(),
    findRecurringDepositsByMember: jest.fn(),
    closeRecurringDeposit: jest.fn(),
    payRdInstallment: jest.fn(),
    calculateAndPostInterest: jest.fn(),
  };

  const mockCertificateService = {
    generateFixedDepositCertificate: jest.fn(),
    generateRecurringDepositCertificate: jest.fn(),
    generateShareCertificate: jest.fn(),
    getCertificateFilePath: jest.fn(),
    deleteCertificate: jest.fn(),
  };

  const mockFixedDeposit = {
    id: 1,
    accountNumber: 'FD24010001',
    memberId: 1,
    principalAmount: 100000,
    interestRate: 8.5,
    depositDate: new Date('2024-01-01'),
    maturityDate: new Date('2025-01-01'),
    tenureMonths: 12,
    maturityAmount: 108500,
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockRecurringDeposit = {
    id: 1,
    accountNumber: 'RD24010001',
    memberId: 1,
    monthlyInstallment: 5000,
    interestRate: 9.0,
    startDate: new Date('2024-01-01'),
    maturityDate: new Date('2026-01-01'),
    tenureMonths: 24,
    maturityAmount: 130000,
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockRdInstallment = {
    id: 1,
    recurringDepositId: 1,
    installmentNumber: 1,
    amount: 5000,
    dueDate: new Date('2024-01-01'),
    status: 'PAID',
    paidDate: new Date('2024-01-01'),
    paidAmount: 5000,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DepositController],
      providers: [
        {
          provide: DepositService,
          useValue: mockDepositService,
        },
        {
          provide: CertificateService,
          useValue: mockCertificateService,
        },
      ],
    }).compile();

    controller = module.get<DepositController>(DepositController);
    depositService = module.get<DepositService>(DepositService);
    certificateService = module.get<CertificateService>(CertificateService);

    // Reset all mocks
    jest.clearAllMocks();
  });

  describe('Fixed Deposit Endpoints', () => {
    describe('createFixedDeposit', () => {
      const createFixedDepositDto: CreateFixedDepositDto = {
        memberId: 1,
        principalAmount: 100000,
        interestRate: 8.5,
        depositDate: '2024-01-01',
        tenureMonths: 12,
        isAutoRenewal: false,
      };

      it('should create a fixed deposit successfully', async () => {
        mockDepositService.createFixedDeposit.mockResolvedValue(mockFixedDeposit);

        const result = await controller.createFixedDeposit(createFixedDepositDto);

        expect(mockDepositService.createFixedDeposit).toHaveBeenCalledWith(createFixedDepositDto);
        expect(result).toEqual(mockFixedDeposit);
      });

      it('should handle service errors', async () => {
        mockDepositService.createFixedDeposit.mockRejectedValue(new NotFoundException('Member not found'));

        await expect(controller.createFixedDeposit(createFixedDepositDto)).rejects.toThrow(NotFoundException);
      });
    });

    describe('findAllFixedDeposits', () => {
      it('should return all fixed deposits', async () => {
        const deposits = [mockFixedDeposit];
        mockDepositService.findAllFixedDeposits.mockResolvedValue(deposits);

        const result = await controller.findAllFixedDeposits();

        expect(mockDepositService.findAllFixedDeposits).toHaveBeenCalled();
        expect(result).toEqual(deposits);
      });
    });

    describe('findFixedDepositById', () => {
      it('should return a fixed deposit by ID', async () => {
        mockDepositService.findFixedDepositById.mockResolvedValue(mockFixedDeposit);

        const result = await controller.findFixedDepositById(1);

        expect(mockDepositService.findFixedDepositById).toHaveBeenCalledWith(1);
        expect(result).toEqual(mockFixedDeposit);
      });

      it('should handle not found error', async () => {
        mockDepositService.findFixedDepositById.mockRejectedValue(new NotFoundException('Fixed deposit not found'));

        await expect(controller.findFixedDepositById(1)).rejects.toThrow(NotFoundException);
      });
    });

    describe('findFixedDepositsByMember', () => {
      it('should return fixed deposits for a member', async () => {
        const deposits = [mockFixedDeposit];
        mockDepositService.findFixedDepositsByMember.mockResolvedValue(deposits);

        const result = await controller.findFixedDepositsByMember(1);

        expect(mockDepositService.findFixedDepositsByMember).toHaveBeenCalledWith(1);
        expect(result).toEqual(deposits);
      });
    });

    describe('updateFixedDeposit', () => {
      const updateDto: UpdateFixedDepositDto = {
        interestRate: 9.0,
        status: 'ACTIVE',
      };

      it('should update a fixed deposit successfully', async () => {
        const updatedDeposit = { ...mockFixedDeposit, interestRate: 9.0 };
        mockDepositService.updateFixedDeposit.mockResolvedValue(updatedDeposit);

        const result = await controller.updateFixedDeposit(1, updateDto);

        expect(mockDepositService.updateFixedDeposit).toHaveBeenCalledWith(1, updateDto);
        expect(result).toEqual(updatedDeposit);
      });
    });

    describe('closeFixedDeposit', () => {
      const closureDto: DepositClosureDto = {
        closureDate: '2024-06-01',
        closureReason: 'Early withdrawal',
        penaltyRate: 1,
      };

      it('should close a fixed deposit successfully', async () => {
        const closedDeposit = { ...mockFixedDeposit, status: 'CLOSED' };
        mockDepositService.closeFixedDeposit.mockResolvedValue(closedDeposit);

        const result = await controller.closeFixedDeposit(1, closureDto);

        expect(mockDepositService.closeFixedDeposit).toHaveBeenCalledWith(1, closureDto);
        expect(result).toEqual(closedDeposit);
      });

      it('should handle bad request error', async () => {
        mockDepositService.closeFixedDeposit.mockRejectedValue(new BadRequestException('Only active deposits can be closed'));

        await expect(controller.closeFixedDeposit(1, closureDto)).rejects.toThrow(BadRequestException);
      });
    });

    describe('processFixedDepositMaturity', () => {
      const maturityDto: DepositMaturityDto = {
        maturityDate: '2025-01-01',
        renewalAction: 'CLOSE',
      };

      it('should process maturity successfully', async () => {
        const maturedDeposit = { ...mockFixedDeposit, status: 'MATURED' };
        mockDepositService.processFixedDepositMaturity.mockResolvedValue(maturedDeposit);

        const result = await controller.processFixedDepositMaturity(1, maturityDto);

        expect(mockDepositService.processFixedDepositMaturity).toHaveBeenCalledWith(1, maturityDto);
        expect(result).toEqual(maturedDeposit);
      });
    });
  });

  describe('Recurring Deposit Endpoints', () => {
    describe('createRecurringDeposit', () => {
      const createRecurringDepositDto: CreateRecurringDepositDto = {
        memberId: 1,
        monthlyInstallment: 5000,
        interestRate: 9.0,
        startDate: '2024-01-01',
        tenureMonths: 24,
      };

      it('should create a recurring deposit successfully', async () => {
        mockDepositService.createRecurringDeposit.mockResolvedValue(mockRecurringDeposit);

        const result = await controller.createRecurringDeposit(createRecurringDepositDto);

        expect(mockDepositService.createRecurringDeposit).toHaveBeenCalledWith(createRecurringDepositDto);
        expect(result).toEqual(mockRecurringDeposit);
      });
    });

    describe('findAllRecurringDeposits', () => {
      it('should return all recurring deposits', async () => {
        const deposits = [mockRecurringDeposit];
        mockDepositService.findAllRecurringDeposits.mockResolvedValue(deposits);

        const result = await controller.findAllRecurringDeposits();

        expect(mockDepositService.findAllRecurringDeposits).toHaveBeenCalled();
        expect(result).toEqual(deposits);
      });
    });

    describe('findRecurringDepositById', () => {
      it('should return a recurring deposit by ID', async () => {
        mockDepositService.findRecurringDepositById.mockResolvedValue(mockRecurringDeposit);

        const result = await controller.findRecurringDepositById(1);

        expect(mockDepositService.findRecurringDepositById).toHaveBeenCalledWith(1);
        expect(result).toEqual(mockRecurringDeposit);
      });
    });

    describe('closeRecurringDeposit', () => {
      const closureDto: DepositClosureDto = {
        closureDate: '2024-06-01',
        closureReason: 'Early closure',
        penaltyRate: 2,
      };

      it('should close a recurring deposit successfully', async () => {
        const closedDeposit = { ...mockRecurringDeposit, status: 'CLOSED' };
        mockDepositService.closeRecurringDeposit.mockResolvedValue(closedDeposit);

        const result = await controller.closeRecurringDeposit(1, closureDto);

        expect(mockDepositService.closeRecurringDeposit).toHaveBeenCalledWith(1, closureDto);
        expect(result).toEqual(closedDeposit);
      });
    });
  });

  describe('RD Installment Endpoints', () => {
    describe('payRdInstallment', () => {
      const paymentDto: PayRdInstallmentDto = {
        paidAmount: 5000,
        paidDate: '2024-01-01',
        paymentMode: 'CASH',
        receiptNumber: 'RCP001',
        remarks: 'Monthly installment',
      };

      it('should pay RD installment successfully', async () => {
        mockDepositService.payRdInstallment.mockResolvedValue(mockRdInstallment);

        const result = await controller.payRdInstallment(1, paymentDto);

        expect(mockDepositService.payRdInstallment).toHaveBeenCalledWith(1, paymentDto);
        expect(result).toEqual(mockRdInstallment);
      });

      it('should handle payment errors', async () => {
        mockDepositService.payRdInstallment.mockRejectedValue(new BadRequestException('Installment already paid'));

        await expect(controller.payRdInstallment(1, paymentDto)).rejects.toThrow(BadRequestException);
      });
    });
  });

  describe('Certificate Endpoints', () => {
    describe('generateFixedDepositCertificate', () => {
      it('should generate fixed deposit certificate successfully', async () => {
        const fileName = 'FD_CERT202401001_1234567890.pdf';
        mockCertificateService.generateFixedDepositCertificate.mockResolvedValue(fileName);

        const result = await controller.generateFixedDepositCertificate('1');

        expect(mockCertificateService.generateFixedDepositCertificate).toHaveBeenCalledWith('1');
        expect(result).toEqual({
          message: 'Certificate generated successfully',
          fileName,
          downloadUrl: `/api/v1/deposits/certificates/download/${fileName}`,
        });
      });

      it('should handle certificate generation errors', async () => {
        mockCertificateService.generateFixedDepositCertificate.mockRejectedValue(new NotFoundException('Fixed deposit not found'));

        await expect(controller.generateFixedDepositCertificate('1')).rejects.toThrow(NotFoundException);
      });
    });

    describe('generateRecurringDepositCertificate', () => {
      it('should generate recurring deposit certificate successfully', async () => {
        const fileName = 'RD_CERT202401001_1234567890.pdf';
        mockCertificateService.generateRecurringDepositCertificate.mockResolvedValue(fileName);

        const result = await controller.generateRecurringDepositCertificate(1);

        expect(mockCertificateService.generateRecurringDepositCertificate).toHaveBeenCalledWith(1);
        expect(result).toEqual({
          message: 'Certificate generated successfully',
          fileName,
          downloadUrl: `/api/v1/deposits/certificates/download/${fileName}`,
        });
      });
    });

    describe('generateShareCertificate', () => {
      it('should generate share certificate successfully', async () => {
        const fileName = 'SH_CERT202401001_1234567890.pdf';
        const shareAmount = 10000;
        mockCertificateService.generateShareCertificate.mockResolvedValue(fileName);

        const result = await controller.generateShareCertificate(1, { shareAmount });

        expect(mockCertificateService.generateShareCertificate).toHaveBeenCalledWith(1, shareAmount);
        expect(result).toEqual({
          message: 'Share certificate generated successfully',
          fileName,
          downloadUrl: `/api/v1/deposits/certificates/download/${fileName}`,
        });
      });
    });

    describe('downloadCertificate', () => {
      it('should download certificate file successfully', async () => {
        const fileName = 'test-certificate.pdf';
        const filePath = '/path/to/certificates/test-certificate.pdf';
        const mockResponse = {
          set: jest.fn(),
        } as unknown as Response;

        mockCertificateService.getCertificateFilePath.mockReturnValue(filePath);
        mockFs.existsSync.mockReturnValue(true);
        mockFs.createReadStream.mockReturnValue({} as any);

        const result = await controller.downloadCertificate(fileName, mockResponse);

        expect(mockCertificateService.getCertificateFilePath).toHaveBeenCalledWith(fileName);
        expect(mockFs.existsSync).toHaveBeenCalledWith(filePath);
        expect(mockResponse.set).toHaveBeenCalledWith({
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${fileName}"`,
        });
        expect(result).toBeDefined();
      });

      it('should throw NotFoundException if file does not exist', async () => {
        const fileName = 'non-existent-certificate.pdf';
        const filePath = '/path/to/certificates/non-existent-certificate.pdf';
        const mockResponse = {} as Response;

        mockCertificateService.getCertificateFilePath.mockReturnValue(filePath);
        mockFs.existsSync.mockReturnValue(false);

        await expect(controller.downloadCertificate(fileName, mockResponse)).rejects.toThrow(NotFoundException);
      });
    });
  });

  describe('Utility Endpoints', () => {
    describe('calculateAndPostInterest', () => {
      it('should calculate and post interest successfully', async () => {
        mockDepositService.calculateAndPostInterest.mockResolvedValue(undefined);

        const result = await controller.calculateAndPostInterest();

        expect(mockDepositService.calculateAndPostInterest).toHaveBeenCalled();
        expect(result).toEqual({ message: 'Interest calculation completed successfully' });
      });

      it('should handle calculation errors', async () => {
        mockDepositService.calculateAndPostInterest.mockRejectedValue(new Error('Calculation failed'));

        await expect(controller.calculateAndPostInterest()).rejects.toThrow('Calculation failed');
      });
    });
  });
});
