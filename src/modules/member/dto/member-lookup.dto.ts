import { IsOptional, IsString } from 'class-validator';

export class MemberLookupQueryDto {
  @IsOptional()
  @IsString()
  search?: string;
}

export class MemberLookupResponseDto {
  memberNo: string;
  name: string;
  basicPay: string;
  dateOfRetire: string;
  officeNo: string;
  address: string;
}
