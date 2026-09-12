import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserSession } from './entities/user-session.entity';
import { PageVisit } from './entities/page-visit.entity';
import { FeatureUsage } from './entities/feature-usage.entity';
import { ErrorLog } from './entities/error-log.entity';
import { AnalyticsConfig } from './entities/analytics-config.entity';
import { AnalyticsTrackingService } from './services/analytics-tracking.service';
import { AnalyticsTrackingController } from './controllers/analytics-tracking.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserSession,
      PageVisit,
      FeatureUsage,
      ErrorLog,
      AnalyticsConfig,
    ], 'analytics'), // Use separate analytics database connection
  ],
  controllers: [AnalyticsTrackingController],
  providers: [AnalyticsTrackingService],
  exports: [AnalyticsTrackingService],
})
export class AnalyticsModule {}