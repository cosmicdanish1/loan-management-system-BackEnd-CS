import { Injectable } from '@nestjs/common';
import { SearchService } from './services/search.service';
import { BalanceService } from './services/balance.service';
import { CalculationService } from './services/calculation.service';

@Injectable()
export class UtilityService {
  constructor(
    private readonly searchService: SearchService,
    private readonly balanceService: BalanceService,
    private readonly calculationService: CalculationService,
  ) {}

  async findAll() {
    return { 
      message: 'Utility services available',
      services: {
        search: 'Advanced search functionality across entities',
        balance: 'Real-time balance calculation and inquiry',
        calculation: 'Financial calculation utilities',
      }
    };
  }

  // Expose search service methods
  getSearchService() {
    return this.searchService;
  }

  // Expose balance service methods
  getBalanceService() {
    return this.balanceService;
  }

  // Expose calculation service methods
  getCalculationService() {
    return this.calculationService;
  }

  // Quick search method for common use cases
  async quickSearch(query: string, entityType?: string) {
    return this.searchService.globalSearch({
      query,
      entityType: entityType as any,
      page: 1,
      limit: 10,
    });
  }

  // Quick balance check
  async quickBalanceCheck(memberId: number) {
    return this.balanceService.getRealtimeBalance(memberId);
  }
}
