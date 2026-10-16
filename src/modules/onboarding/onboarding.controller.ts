import { Body, Controller, ForbiddenException, Get, Post, Put, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RoleGuard } from '../auth/guards/role.guard';
import { UserRole } from '../auth/entities/user.entity';
import { OnboardingService } from './onboarding.service';
import { TermsService } from './terms.service';

class ModeDto {
    @IsString() @MaxLength(10) mode: string;
}
class CompleteDto {
    @IsOptional() @IsString() @MaxLength(50) version?: string;
}
class AcceptTermsDto {
    @IsString() @MaxLength(30) version: string;
}
class PublishTermsDto {
    @IsString() @MaxLength(30) version: string;
    @IsString() @MaxLength(50000) text: string;
}
class StepDto {
    @IsString() @MaxLength(40) step: string;
}

function userIdOf(req: any): number {
    const id = Number(req.user?.userid ?? req.user?.id);
    if (!Number.isInteger(id)) throw new UnauthorizedException();
    return id;
}

// Every logged-in user manages their OWN onboarding; only the global default is admin only.
@ApiTags('Onboarding')
@Controller('onboarding')
@UseGuards(JwtAuthGuard, RoleGuard)
export class OnboardingController {
    constructor(private readonly service: OnboardingService, private readonly terms: TermsService) { }

    @ApiOperation({ summary: 'Should the walkthrough start for the current user, and under which mode; plus terms acceptance' })
    @Get('status')
    async status(@Req() req: any) {
        const userId = userIdOf(req);
        const [onboarding, terms] = await Promise.all([this.service.getStatus(userId), this.terms.status(userId)]);
        return { ...onboarding, terms };
    }

    @ApiOperation({ summary: 'Own profile summary for the welcome card' })
    @Get('profile')
    profile(@Req() req: any) {
        return this.service.getProfile(userIdOf(req));
    }

    @ApiOperation({ summary: 'Current Terms & Conditions text and version' })
    @Get('terms')
    getTerms() {
        return this.terms.getTerms();
    }

    @ApiOperation({ summary: 'Accept the given version of the terms' })
    @Post('terms/accept')
    acceptTerms(@Body() dto: AcceptTermsDto, @Req() req: any) {
        return this.terms.accept(userIdOf(req), req.user?.username ?? null, dto.version);
    }

    @ApiOperation({ summary: 'Admin: publish new terms; everyone must accept the new version' })
    @Put('terms')
    publishTerms(@Body() dto: PublishTermsDto, @Req() req: any) {
        const role = String(req.user?.role || '').toLowerCase();
        if (role !== UserRole.ADMIN && role !== UserRole.SYSTEM) throw new ForbiddenException('Administrator only');
        return this.terms.publish(dto.version, dto.text);
    }

    @ApiOperation({ summary: 'Mark the walkthrough finished or skipped' })
    @Post('complete')
    complete(@Body() dto: CompleteDto, @Req() req: any) {
        return this.service.complete(userIdOf(req), dto.version);
    }

    @Post('step')
    async step(@Body() dto: StepDto, @Req() req: any) {
        await this.service.saveStep(userIdOf(req), dto.step);
        return { ok: true };
    }

    @ApiOperation({ summary: "Current user's own preference: default | first | always | never" })
    @Put('preference')
    preference(@Body() dto: ModeDto, @Req() req: any) {
        return this.service.setUserMode(userIdOf(req), dto.mode);
    }

    @ApiOperation({ summary: 'Admin: global default for everyone who has not set their own' })
    @Put('global-mode')
    globalMode(@Body() dto: ModeDto, @Req() req: any) {
        const role = String(req.user?.role || '').toLowerCase();
        if (role !== UserRole.ADMIN && role !== UserRole.SYSTEM) throw new ForbiddenException('Administrator only');
        return this.service.setGlobalMode(dto.mode);
    }
}
