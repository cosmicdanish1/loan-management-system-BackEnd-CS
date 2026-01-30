import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';
import { BackupLog } from './entities/backup-log.entity';

@Module({
  imports: [TypeOrmModule.forFeature([BackupLog])],
  controllers: [BackupController],
  providers: [BackupService],
  exports: [BackupService],
})
export class BackupModule { }