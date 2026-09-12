import { Body, Controller, Get, Param, Post, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RdRepaymentService } from '../services/rd-repayment.service';

interface RecordRdPaymentBody {
    installmentMonth: number;
    installmentYear: number;
    amount: number;
    paidDate?: string;
    narration?: string;
    recordedBy: string;
}

@ApiTags('RD - Counter Repayment')
@Controller('rd/repayment')
@UseGuards(JwtAuthGuard)
export class RdRepaymentController {
    constructor(private readonly service: RdRepaymentService) { }

    @Get(':mbno/:yearcode/pending')
    @ApiOperation({ summary: "A member's 12 RD months for the financial year, with each one's current payment status" })
    async getPending(@Param('mbno') mbno: string, @Param('yearcode', ParseIntPipe) yearcode: number) {
        // No manual {success,data} wrapper -- see rd-member-config.controller.ts's comment.
        return this.service.getPendingInstallments(mbno, yearcode);
    }

    @Post(':mbno/:yearcode')
    @ApiOperation({ summary: "Record a member's RD payment for one specific month at the counter — amount used exactly as entered" })
    async recordPayment(
        @Param('mbno') mbno: string,
        @Param('yearcode', ParseIntPipe) yearcode: number,
        @Body() body: RecordRdPaymentBody,
    ) {
        const result = await this.service.recordPayment(
            mbno, yearcode, body.installmentMonth, body.installmentYear, Number(body.amount),
            body.paidDate ? new Date(body.paidDate) : new Date(),
            body.narration, body.recordedBy,
        );
        return { ...result, message: 'RD payment recorded.' };
    }
}
