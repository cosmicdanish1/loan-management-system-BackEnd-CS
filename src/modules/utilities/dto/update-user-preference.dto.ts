import { IsOptional, IsString, IsNumber, IsEnum, Min, Max, IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateUserPreferenceDto {
    @ApiProperty({ description: 'Interface theme mode', enum: ['light', 'dark', 'system'], required: false })
    @IsOptional()
    @IsEnum(['light', 'dark', 'system'])
    interfaceMode?: 'light' | 'dark' | 'system';

    @ApiProperty({ description: 'Accent color hex code', required: false })
    @IsOptional()
    @IsString()
    accentColor?: string;

    @ApiProperty({ description: 'Font scaling factor', minimum: 0.8, maximum: 1.5, required: false })
    @IsOptional()
    @IsNumber()
    @Min(0.8)
    @Max(1.5)
    fontScale?: number;

    @ApiProperty({ description: 'UI density factor', minimum: 0.7, maximum: 1.3, required: false })
    @IsOptional()
    @IsNumber()
    @Min(0.7)
    @Max(1.3)
    density?: number;

    @ApiProperty({ description: 'Corner radius in pixels', minimum: 0, maximum: 20, required: false })
    @IsOptional()
    @IsNumber()
    @Min(0)
    @Max(20)
    cornerRadius?: number;

    @ApiProperty({ description: 'Font family', required: false })
    @IsOptional()
    @IsString()
    fontFamily?: string;

    @ApiProperty({ description: 'Background type', enum: ['image', 'gradient', 'solid'], required: false })
    @IsOptional()
    @IsEnum(['image', 'gradient', 'solid'])
    backgroundType?: 'image' | 'gradient' | 'solid';

    @ApiProperty({ description: 'Background color 1', required: false })
    @IsOptional()
    @IsString()
    backgroundColor1?: string;

    @ApiProperty({ description: 'Background color 2', required: false })
    @IsOptional()
    @IsString()
    backgroundColor2?: string;

    @ApiProperty({ description: 'Background image (Base64 or URL)', required: false })
    @IsOptional()
    @IsString()
    backgroundImage?: string;

    @ApiProperty({ description: 'Text color', required: false })
    @IsOptional()
    @IsString()
    textColor?: string;

    @ApiProperty({ description: 'Enable notifications', required: false })
    @IsOptional()
    @IsBoolean()
    notifications?: boolean;

    @ApiProperty({ description: 'Sync across windows', required: false })
    @IsOptional()
    @IsBoolean()
    syncAcrossWindows?: boolean;

    @ApiProperty({ description: 'Enable sound effects', required: false })
    @IsOptional()
    @IsBoolean()
    soundEffects?: boolean;

    @ApiProperty({ description: 'Enable inactivity logout', required: false })
    @IsOptional()
    @IsBoolean()
    inactivityLogout?: boolean;

    @ApiProperty({ description: 'Inactivity timeout in minutes', required: false })
    @IsOptional()
    @IsNumber()
    inactivityTimeoutMinutes?: number;
}
