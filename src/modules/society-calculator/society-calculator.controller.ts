import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireMenuAction } from '../auth/guards/menu-right.guard';
import { SocietyCalculatorService } from './society-calculator.service';
import { LoanEmiDto } from './dto/loan-emi.dto';

/** The tabs of the window that share one generic endpoint. Every one validates its own input with a plain-language 400. */
export const CALCULATOR_KINDS = [
  'closure', 'penalty', 'sb-interest', 'fd-interest', 'rd-interest', 'eligibility', 'loan-against-rd',
  'consolidation', 'reagreement', 'dividend', 'insurance', 'saakh',
] as const;

/**
 * Society Calculator (ES-525): what-if figures for staff. Every endpoint is read only, writes nothing and needs no member.
 * The window is gated by the SOCIETY_CALCULATOR menu right (Configure UserLevel Default Rights).
 */
@ApiTags('Society Calculator')
@ApiBearerAuth()
@Controller('society-calculator')
export class SocietyCalculatorController {
  constructor(private readonly service: SocietyCalculatorService) {}

  @Get('rules')
  @RequireMenuAction('SOCIETY_CALCULATOR')
  @ApiOperation({ summary: 'Live Business Rules (rates, grace, penalty, slot window, rounding) used by the calculator' })
  async rules() {
    return this.service.getRules();
  }

  @Post('loan-emi')
  @HttpCode(200)
  @RequireMenuAction('SOCIETY_CALCULATOR')
  @ApiOperation({ summary: 'Society-method loan EMI: slot, delay interest, constant EMI, schedule (read only)' })
  async loanEmi(@Body() dto: LoanEmiDto) {
    return this.service.loanEmi(dto);
  }

  @Post(':kind')
  @HttpCode(200)
  @RequireMenuAction('SOCIETY_CALCULATOR')
  @ApiOperation({ summary: 'Other calculators: closure, penalty, sb/fd/rd interest, eligibility, consolidation, re-agreement, dividend, insurance, saakh (read only)' })
  async calculate(@Param('kind') kind: string, @Body() body: Record<string, any>) {
    if (!(CALCULATOR_KINDS as readonly string[]).includes(kind)) throw new NotFoundException(`Unknown calculator '${kind}'.`);
    return this.service.calculate(kind, body ?? {});
  }
}
