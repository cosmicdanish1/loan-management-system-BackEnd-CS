import { Test, TestingModule } from '@nestjs/testing';
import { UtilityController } from './utility.controller';
import { UtilityService } from './utility.service';
import { SearchService } from './services/search.service';
import { BalanceService } from './services/balance.service';
import { InterestRateUpdateService } from './services/interest-rate-update.service';
import { DataConsistencyService } from './services/data-consistency.service';
import { DataCorrectionService } from './services/data-correction.service';
import { SystemHealthMonitoringService } from './services/system-health-monitoring.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SearchEntityType } from './dto/search.dto';

describe('UtilityController', () => {
  let controller: UtilityController;
  let utilityService: UtilityService;
  let searchService: SearchService;
  let balanceService: BalanceService;
  let interestRateUpdateService: InterestRateUpdateService;
  let dataConsistencyService: DataConsistencyService;
  let dataCorrectionService: DataCorrectionService;
  let systemHealthMonitoringService
