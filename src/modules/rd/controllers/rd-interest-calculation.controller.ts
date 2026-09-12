import { Controller, Get, Param, Query, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RdInterestCalculationService } from '../services/rd-interest-calculation.service';

@ApiTags('RD - Interest Calculation')
@Controller('rd/interest')
@UseGuards(JwtAuthGuard)
export class RdInterestCalculationController {
    constructor(private readonly service: RdInterestCalculationService) { }

    @Get(':mbno/:yearcode/preview')
    @ApiOperation({ summary: "Preview a member's RD installment + opening-balance interest for a financial year" })
    async preview(
        @Param('mbno') mbno: string,
        @Param('yearcode', ParseIntPipe) yearcode: number,
        @Query('overrideEligible') overrideEligible?: string,
    ) {
        const override = overrideEligible === undefined ? undefined : overrideEligible === 'true';
        // No manual {success,data} wrapper -- see rd-member-config.controller.ts's comment.
        return this.service.previewTotalInterest(mbno, yearcode, override);
    }
}
