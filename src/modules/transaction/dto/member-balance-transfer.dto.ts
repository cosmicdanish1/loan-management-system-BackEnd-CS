import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

/** One member row of a generated transfer, as the review grid sends it back. Only `mbno` is trusted; amounts are recomputed. */
export class MemberTransferEntryDto {
  @IsOptional() @IsNumber() srNo?: number;
  @IsString() @IsNotEmpty() mbno: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsNumber() dbHeadBal?: number;
  @IsOptional() @IsNumber() crHeadBal?: number;
  @IsOptional() @IsNumber() dbAmt?: number;
  @IsOptional() @IsNumber() crAmt?: number;
  @IsOptional() @IsNumber() exCrAmt?: number;
}

export class GenerateMemberBalanceTransferDto {
  @IsString() @IsNotEmpty() debitHead: string;
  @IsString() @IsNotEmpty() creditHead: string;
  @IsNumber() @Min(0) creditLimit: number;
  @IsOptional() @IsString() excessHead?: string;
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}/, { message: 'balanceAsOn must be a date (YYYY-MM-DD)' }) balanceAsOn: string;
}

export class PostMemberBalanceTransferDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20000)
  @ValidateNested({ each: true })
  @Type(() => MemberTransferEntryDto)
  entries: MemberTransferEntryDto[];

  @IsString() @IsNotEmpty() debitHead: string;
  @IsString() @IsNotEmpty() creditHead: string;
  @IsOptional() @IsString() excessHead?: string;
  /** Accepted for compatibility with the screen but ignored: the logged-in user from the token is used. */
  @IsOptional() @IsString() postedBy?: string;
  @IsOptional() @IsNumber() @Min(0) creditLimit?: number;
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}/, { message: 'balanceAsOn must be a date (YYYY-MM-DD)' }) balanceAsOn?: string;
}
