import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, MaxLength, Min, ValidateNested } from 'class-validator';

const MBNO = /^\d{1,18}$/;

export class ActivationRequestDto {
  @IsString() @Matches(MBNO, { message: 'mbno must be the member number' }) mbno: string;
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dob must be YYYY-MM-DD' }) dob: string;
  @IsString() @Matches(/^[A-Za-z0-9]{4}$/, { message: 'panLast4 must be the last 4 characters of the PAN' }) panLast4: string;
  @IsString() @Matches(/^\d{4}$/, { message: 'phoneLast4 must be the last 4 digits of the phone' }) phoneLast4: string;
  @IsOptional() @IsString() @Length(8, 100) deviceId?: string;
}

export class ActivateDto {
  @IsString() @Matches(MBNO) mbno: string;
  @IsString() @Length(6, 20) code: string;
  @IsString() @Length(8, 100) deviceId: string;
}

class ConsentDto {
  @IsOptional() @IsInt() @Min(1) termsVersion?: number;
  @IsOptional() @IsInt() @Min(1) privacyVersion?: number;
}

export class ActivateCompleteDto {
  @IsString() @MaxLength(2000) ticket: string;
  @IsString() @Matches(/^\d{6}$/, { message: 'mpin must be 6 digits' }) mpin: string;
  @IsString() @Length(8, 100) deviceId: string;
  @IsOptional() @IsIn(['android', 'ios']) platform?: string;
  @IsOptional() @IsString() @MaxLength(100) model?: string;
  @IsOptional() @IsString() @MaxLength(40) osVersion?: string;
  @IsOptional() @IsString() @MaxLength(20) appVersion?: string;
  @IsOptional() @ValidateNested() @Type(() => ConsentDto) consent?: ConsentDto;
}

/** Sign in with the member number OR the registered mobile number (only when that number belongs to exactly one member). */
export class LoginDto {
  @IsOptional() @IsString() @Matches(MBNO) mbno?: string;
  @IsOptional() @IsString() @Matches(/^\d{10}$/, { message: 'mobile must be the 10-digit registered mobile number' }) mobile?: string;
  @IsString() @Matches(/^\d{6}$/, { message: 'mpin must be 6 digits' }) mpin: string;
  @IsString() @Length(8, 100) deviceId: string;
}

export class ChangeMpinDto {
  @IsString() @Matches(/^\d{6}$/, { message: 'oldMpin must be 6 digits' }) oldMpin: string;
  @IsString() @Matches(/^\d{6}$/, { message: 'newMpin must be 6 digits' }) newMpin: string;
}

export class ActivationStatusQueryDto {
  @IsString() @Matches(MBNO, { message: 'mbno must be the member number' }) mbno: string;
}

export class RefreshDto {
  @IsString() @MaxLength(200) refreshToken: string;
  @IsString() @Length(8, 100) deviceId: string;
}

export class LogoutDto {
  @IsOptional() @IsString() @MaxLength(200) refreshToken?: string;
  @IsString() @Length(8, 100) deviceId: string;
}

export class StepUpDto {
  @IsString() @MaxLength(40) action: string;
  @IsString() @Matches(/^\d{6}$/, { message: 'code must be 6 digits' }) code: string;
}
