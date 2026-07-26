import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UtilitiesController } from './utilities.controller';
import { UtilitiesService } from './utilities.service';
import { UserPreference } from './entities/user-preference.entity';
import { SystemSetting } from './entities/system-setting.entity';
import { LoanV2Module } from '../loan/loan-v2.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserPreference, SystemSetting]),
    forwardRef(() => LoanV2Module)
  ],
  controllers: [UtilitiesController],
  providers: [UtilitiesService],
  exports: [UtilitiesService],
})
export class UtilitiesModule { }