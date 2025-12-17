import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ReportService } from './report.service';
import { CashBookMonthlyDto } from './dto/cash-book-monthly.dto';
import { DetailLedgerDto } from './dto/detail-ledger.dto';
import { BankDetailLedgerDto } from './dto/bank-detail-ledger.dto';
import { DefaulterListDto } from './dto/defaulter-list.dto';
import { NewLoanDisbursedDto } from './dto/new-loan-disbursed.dto';
import { MemberLoanLedgerDto } from './dto/member-loan-ledger.dto';

@ApiTags('Reports')
@Controller('report')
export class ReportController {
  constructor(private readonly reportService: ReportService) { }

  @Get('cash-book-monthly')
  getCashBookMonthly(@Query() query: CashBookMonthlyDto) {
    return this.reportService.getCashBookMonthly(query);
  }

  @Get('detail-ledger')
  getDetailLedger(@Query() query: DetailLedgerDto) {
    return this.reportService.getDetailLedger(query);
  }

  @Get('head-list')
  getHeadList() {
    return this.reportService.getHeadList();
  }

  @Get('bank-list')
  getBankList() {
    return this.reportService.getBankList();
  }

  @Get('bank-detail-ledger')
  getBankDetailLedger(@Query() query: BankDetailLedgerDto) {
    return this.reportService.getBankDetailLedger(query);
  }

  @Get('defaulter-list')
  getDefaulterList(@Query() query: DefaulterListDto) {
    return this.reportService.getDefaulterList(query);
  }

  @Get('loan-types')
  getLoanTypes() {
    return this.reportService.getLoanTypes();
  }

  @Get('new-loan-disbursed')
  getNewLoanDisbursed(@Query() query: NewLoanDisbursedDto) {
    return this.reportService.getNewLoanDisbursed(query);
  }

  @Get('member-loan-ledger')
  getMemberLoanLedger(@Query() query: MemberLoanLedgerDto) {
    return this.reportService.getMemberLoanLedger(query);
  }

  @Get()
  async findAll() {
    return { message: 'Report endpoints - To be implemented' };
  }
}
