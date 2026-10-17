import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { TermsService } from './terms.service';
import { ChecklistService } from './checklist.service';
import { InsightsService } from './insights.service';

@Module({
    controllers: [OnboardingController],
    providers: [OnboardingService, TermsService, ChecklistService, InsightsService],
    exports: [OnboardingService, TermsService],
})
export class OnboardingModule { }
