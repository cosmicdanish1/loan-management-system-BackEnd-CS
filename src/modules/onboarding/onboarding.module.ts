import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { TermsService } from './terms.service';

@Module({
    controllers: [OnboardingController],
    providers: [OnboardingService, TermsService],
    exports: [OnboardingService, TermsService],
})
export class OnboardingModule { }
