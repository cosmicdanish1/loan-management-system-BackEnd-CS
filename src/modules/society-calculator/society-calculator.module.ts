import { Module } from '@nestjs/common';
import { SocietyCalculatorController } from './society-calculator.controller';
import { SocietyCalculatorService } from './society-calculator.service';

/** Society Calculator (ES-525): read-only what-if calculations for staff. Uses the DataSource only to read Business Rules. */
@Module({
  controllers: [SocietyCalculatorController],
  providers: [SocietyCalculatorService],
})
export class SocietyCalculatorModule {}
