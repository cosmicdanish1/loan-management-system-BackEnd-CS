import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BalanceService } from './balance.service';
import { Member } from '../../member/entities/member.entity';
import { LoanAccount } from '../../loan/entities/loan-account.entity';
import { FixedDeposit } from '../../deposit/entities/fixed-deposit.entity';
import { Transaction } from '../../transaction/entities/transaction.entity';

describe('BalanceService', () => {
  let service: BalanceService;
  let memberRepository: Repository<Member>;
  let loanRepository: Repository<LoanAccount>;
  let depositRepository: Repository<FixedDeposit>;
  let transactionRepository: Repository<Transaction>;

  const mockMember = {
    id: 1,
    memberNumber: 'M001',
    firstName: 'John',
    lastName: 'Doe',
    shareAmount: 1000,
    fullName: 'John Doe',
  };

  const mockLoan = {
    id: 1,
    accountNumber: 'L001',
    outstandingBalance: 5000,
    status: 'ACTIVE',
    updatedAt: new Date('2024-01-01'),
  };

  const mockDeposit = {
    id: 1,
    accountNumber: 'FD001',
    principalAmount: 10000,
    interestAccrued: 500,
    status: 'ACTIVE',
    currentValue: 10500,
    updatedAt: new Date('2024-01-01'),
  };

  const mockQueryBuilder = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    getRawOne: jest.fn(),
    getOne: jest.fn(),
    getMany: jest.fn(),
  };

  const mockRepository = {
    findOne: jest.fn(),
    find: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceService,
        {
          provide: getRepositoryToken(Member),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(LoanAccount),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(FixedDeposit),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(Transaction),
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<BalanceService>(BalanceService);
    memberRepository = module.get<Repository<Member>>(getRepositoryToken(Member));
    loanRepository = module.get<Repository<LoanAccount>>(getRepositoryToken(LoanAccount));
    depositRepository = module.get<Repository<FixedDeposit>>(getRepositoryToken(FixedDeposit));
    transactionRepository = module.get<Repository<Transaction>>(getRepositoryToken(Transaction));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getMemberBalance', () => {
    it('should calculate member balance correctly', async () => {
      memberRepository.findOne = jest.fn().mockResolvedValue(mockMember);
      mockQueryBuilder.getRawOne = jest.fn()
        .mockResolvedValueOnce({ totalBalance: '5000' }) // loan balance
        .mockResolvedValueOnce({ totalBalance: '10500' }); // deposit balance
      mockQueryBuilder.getOne = jest.fn().mockResolvedValue({
        transactionDate: new Date('2024-01-01'),
      });

      const result = await service.getMemberBalance({ memberId: 1 });

      expect(result).toEqual({
        memberId: 1,
        memberNumber: 'M001',
        memberName: 'John Doe',
        shareBalance: 1000,
        totalLoanBalance: 5000,
        totalDepositBalance: 10500,
        netBalance: 6500, // 1000 + 10500 - 5000
        lastTransactionDate: new Date('2024-01-01'),
        asOfDate: expect.any(Date),
      });
    });

    it('should throw error for non-existent member', async () => {
      memberRepository.findOne = jest.fn().mockResolvedValue(null);

      await expect(service.getMemberBalance({ memberId: 999 })).rejects.toThrow('Member not found');
    });

    it('should handle member with no transactions', async () => {
      memberRepository.findOne = jest.fn().mockResolvedValue(mockMember);
      mockQueryBuilder.getRawOne = jest.fn()
        .mockResolvedValueOnce({ totalBalance: null })
        .mockResolvedValueOnce({ totalBalance: null });
      mockQueryBuilder.getOne = jest.fn().mockResolvedValue(null);

      const result = await service.getMemberBalance({ memberId: 1 });

      expect(result.totalLoanBalance).toBe(0);
      expect(result.totalDepositBalance).toBe(0);
      expect(result.netBalance).toBe(1000); // Only share balance
      expect(result.lastTransactionDate).toBeNull();
    });
  });

  describe('getAccountBalance', () => {
    it('should get loan account balance', async () => {
      loanRepository.findOne = jest.fn().mockResolvedValue(mockLoan);
      mockQueryBuilder.getOne = jest.fn().mockResolvedValue({
        transactionDate: new Date('2024-01-01'),
      });

      const result = await service.getAccountBalance('loan', 1);

      expect(result).toEqual({
        accountId: 1,
        accountNumber: 'L001',
        accountType: 'loan',
        currentBalance: 5000,
        availableBalance: 5000,
        lastTransactionDate: new Date('2024-01-01'),
        status: 'ACTIVE',
      });
    });

    it('should get deposit account balance', async () => {
      depositRepository.findOne = jest.fn().mockResolvedValue(mockDeposit);
      mockQueryBuilder.getOne = jest.fn().mockResolvedValue({
        transactionDate: new Date('2024-01-01'),
      });

      const result = await service.getAccountBalance('deposit', 1);

      expect(result).toEqual({
        accountId: 1,
        accountNumber: 'FD001',
        accountType: 'deposit',
        currentBalance: 10500,
        availableBalance: 10500,
        lastTransactionDate: new Date('2024-01-01'),
        status: 'ACTIVE',
      });
    });

    it('should throw error for invalid account type', async () => {
      await expect(service.getAccountBalance('invalid', 1)).rejects.toThrow('Invalid account type');
    });

    it('should throw error for non-existent account', async () => {
      loanRepository.findOne = jest.fn().mockResolvedValue(null);

      await expect(service.getAccountBalance('loan', 999)).rejects.toThrow('Account not found');
    });
  });

  describe('getMemberAccountBalances', () => {
    it('should get all account balances for a member', async () => {
      const mockLoanForBalance = { ...mockLoan, accountNumber: 'L001' };
      const mockDepositForBalance = { ...mockDeposit, accountNumber: 'FD001' };
      
      memberRepository.findOne = jest.fn().mockResolvedValue(mockMember);
      loanRepository.find = jest.fn().mockResolvedValue([mockLoanForBalance]);
      depositRepository.find = jest.fn().mockResolvedValue([mockDepositForBalance]);

      const result = await service.getMemberAccountBalances(1);

      expect(result).toEqual({
        shareBalance: 1000,
        loanAccounts: [
          {
            accountId: 1,
            accountNumber: 'L001',
            accountType: 'loan',
            currentBalance: 5000,
            availableBalance: 5000,
            lastTransactionDate: new Date('2024-01-01'),
            status: 'ACTIVE',
          },
        ],
        depositAccounts: [
          {
            accountId: 1,
            accountNumber: 'FD001',
            accountType: 'deposit',
            currentBalance: 10500,
            availableBalance: 10500,
            lastTransactionDate: new Date('2024-01-01'),
            status: 'ACTIVE',
          },
        ],
        totalLoanBalance: 5000,
        totalDepositBalance: 10500,
        netWorth: 6500,
      });
    });

    it('should throw error for non-existent member', async () => {
      memberRepository.findOne = jest.fn().mockResolvedValue(null);

      await expect(service.getMemberAccountBalances(999)).rejects.toThrow('Member not found');
    });
  });

  describe('generateAccountStatement', () => {
    it('should generate account statement for member', async () => {
      const statementDto = {
        memberId: 1,
        fromDate: '2024-01-01',
        toDate: '2024-01-31',
      };

      memberRepository.findOne = jest.fn().mockResolvedValue(mockMember);
      mockQueryBuilder.getMany = jest.fn().mockResolvedValue([
        {
          transactionDate: new Date('2024-01-15'),
          transactionNumber: 'T001',
          description: 'Test transaction',
          amount: 1000,
          creditAccount: 'M001-SHARE',
          voucherNumber: 'V001',
          remarks: 'Test',
        },
      ]);
      mockQueryBuilder.getRawOne = jest.fn().mockResolvedValue({ balance: '0' });

      const result = await service.generateAccountStatement(statementDto);

      expect(result).toHaveProperty('member');
      expect(result).toHaveProperty('account');
      expect(result).toHaveProperty('period');
      expect(result).toHaveProperty('transactions');
      expect(result).toHaveProperty('summary');
      expect(result.member.memberNumber).toBe('M001');
      expect(result.transactions).toHaveLength(1);
    });

    it('should throw error for non-existent member', async () => {
      memberRepository.findOne = jest.fn().mockResolvedValue(null);

      const statementDto = {
        memberId: 999,
        fromDate: '2024-01-01',
        toDate: '2024-01-31',
      };

      await expect(service.generateAccountStatement(statementDto)).rejects.toThrow('Member not found');
    });
  });

  describe('getRealtimeBalance', () => {
    it('should return real-time balance', async () => {
      memberRepository.findOne = jest.fn().mockResolvedValue(mockMember);
      mockQueryBuilder.getRawOne = jest.fn()
        .mockResolvedValueOnce({ totalBalance: '5000' })
        .mockResolvedValueOnce({ totalBalance: '10500' });
      mockQueryBuilder.getOne = jest.fn().mockResolvedValue(null);

      const result = await service.getRealtimeBalance(1);

      expect(result).toHaveProperty('memberId', 1);
      expect(result).toHaveProperty('netBalance', 6500);
    });
  });
});
