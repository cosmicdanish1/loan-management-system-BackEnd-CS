import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const SUPPORT_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

export const SUPPORT_QUERY_TYPES = ['BUG', 'QUESTION', 'DATA_CORRECTION', 'FEATURE_REQUEST', 'OTHER'] as const;

export class CreateSupportQueryDto {
    @IsOptional()
    @IsIn(SUPPORT_QUERY_TYPES as unknown as string[])
    queryType?: (typeof SUPPORT_QUERY_TYPES)[number];

    @IsString()
    @MinLength(5)
    @MaxLength(200)
    subject: string;

    @IsString()
    @MinLength(10)
    @MaxLength(5000)
    description: string;

    @IsOptional()
    @IsString()
    @MaxLength(80)
    module?: string;

    @IsOptional()
    @IsIn(SUPPORT_PRIORITIES as unknown as string[])
    priority?: (typeof SUPPORT_PRIORITIES)[number];

    // Captured automatically by the frontend: current screen, app version, OS/browser.
    @IsOptional()
    @IsString()
    @MaxLength(300)
    route?: string;

    @IsOptional()
    @IsString()
    @MaxLength(50)
    appVersion?: string;

    @IsOptional()
    @IsString()
    @MaxLength(1000)
    clientInfo?: string;
}
