import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CalculatorRules, loadCalculatorRules } from './engine/rules';
import { computeLoanEmi, LoanEmiResult } from './engine/loan.engine';
import { computeClosure } from './engine/closure.engine';
import { computePenalty } from './engine/penalty.engine';
import { computeFd, computeRd, computeSb } from './engine/deposit.engine';
import {
  computeConsolidation, computeDividend, computeEligibility, computeInsurance, computeLoanAgainstRd, computeReagreement, computeSaakh,
} from './engine/member.engine';
import { LoanEmiDto } from './dto/loan-emi.dto';

type Body = Record<string, any>;

/**
 * Society Calculator (ES-525). READ ONLY: this service never writes to the database. It loads the live Business Rules and
 * hands them, with the typed numbers, to the pure engine functions.
 */
@Injectable()
export class SocietyCalculatorService {
  constructor(private readonly dataSource: DataSource) {}

  /** Live Business Rules the calculator uses (shown in the window so a user sees which rates were applied). */
  getRules(): Promise<CalculatorRules> {
    return loadCalculatorRules(this.dataSource);
  }

  /** Phase 1: society-method loan EMI. */
  async loanEmi(dto: LoanEmiDto): Promise<LoanEmiResult> {
    return computeLoanEmi(dto, await this.getRules());
  }

  /** One entry point for every other calculator: `kind` picks the pure engine function. */
  async calculate(kind: string, body: Body): Promise<unknown> {
    const rules = await this.getRules();
    switch (kind) {
      case 'closure': return computeClosure(body, rules);
      case 'penalty': return computePenalty(body, rules);
      case 'sb-interest': return computeSb(body);
      case 'fd-interest': return computeFd(body);
      case 'rd-interest': return computeRd(body, rules);
      case 'eligibility': return computeEligibility(body, rules);
      case 'loan-against-rd': return computeLoanAgainstRd(body, rules);
      case 'consolidation': return computeConsolidation(body, rules);
      case 'reagreement': return computeReagreement(body, rules);
      case 'dividend': return computeDividend(body);
      case 'insurance': return computeInsurance(body);
      case 'saakh': return computeSaakh(body);
      default: return undefined;
    }
  }
}
