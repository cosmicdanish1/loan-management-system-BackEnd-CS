import { Module } from '@nestjs/common';
import { MemberStatusController } from './member-status.controller';
import { MemberStatusService } from './member-status.service';

// ES-100: shared active/inactive rule, the manual "mark inactive" action and the Member Status window's data.
@Module({
  controllers: [MemberStatusController],
  providers: [MemberStatusService],
  exports: [MemberStatusService],
})
export class MemberStatusModule {}
