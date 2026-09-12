import { Controller, Get, Param, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RdPatternEligibilityService } from '../services/rd-pattern-eligibility.service';

@ApiTags('RD - Payment Pattern Eligibility')
@Controller('rd/pattern')
@UseGuards(JwtAuthGuard)
export class RdPatternEligibilityController {
    constructor(private readonly service: RdPatternEligibilityService) { }

    @Get(':mbno/:yearcode')
    @ApiOperation({ summary: "Preview a member's RD payment-pattern eligibility for a financial year" })
    async evaluate(@Param('mbno') mbno: string, @Param('yearcode', ParseIntPipe) yearcode: number) {
        // No manual {success,data} wrapper -- the global TransformInterceptor
        // already adds one; see rd-member-config.controller.ts's comment.
        return this.service.evaluateMember(mbno, yearcode);
    }
}
