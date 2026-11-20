import { BadRequestException } from '@nestjs/common';
import { LoanV2Controller } from '../../../src/modules/loan/loan-v2.controller';

/**
 * ES-580: the immediate "settle now" early closure endpoint lowered RD/CD and Share and closed the loan with no ledger,
 * voucher or cash book. Every closure now goes through Past Transaction (hold), so the old endpoint refuses and never
 * reaches the service.
 */
describe('POST early-closure/execute is retired (ES-580)', () => {
  it('refuses with a message that points to Past Transaction, and does not touch the loan service', async () => {
    const loanRepaymentService = { executeEarlyClosure: jest.fn() };
    const controller: any = Object.create(LoanV2Controller.prototype);
    controller.loanRepaymentService = loanRepaymentService;

    await expect(controller.executeEarlyClosure('LC1', { mbno: '1001' }, { user: { username: 'x' } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.executeEarlyClosure()).rejects.toThrow(/Past Transaction/);
    expect(loanRepaymentService.executeEarlyClosure).not.toHaveBeenCalled();
  });
});
