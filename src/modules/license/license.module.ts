import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LicenseKey } from './entities/license-key.entity';
import { LicenseService } from './license.service';
import { LicenseController } from './license.controller';

@Module({
  imports: [TypeOrmModule.forFeature([LicenseKey])],
  controllers: [LicenseController],
  providers: [LicenseService],
  exports: [LicenseService],
})
export class LicenseModule {}
