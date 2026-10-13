import { Module } from '@nestjs/common';
import { NotificationCentreController } from './notification-centre.controller';
import { NotificationCentreService } from './notification-centre.service';

// ES-101: one place for every system notification (members to inactivate, insurance, negative RD, message delivery, day-end).
@Module({
  controllers: [NotificationCentreController],
  providers: [NotificationCentreService],
  exports: [NotificationCentreService],
})
export class NotificationCentreModule {}
