import { IsOptional, IsString, IsNumber, IsDateString, IsArray, IsEnum } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class SearchFiltersDto {
  @ApiPropertyOptional({ description: 'General search query' })
  @IsOptional()
  @IsString()
  query?: string;

  @ApiPropertyOptional({ description: 'Member number to search' })
  @IsOptional()
  @IsString()
  memberNumber?: string;

  @ApiPropertyOptional({ description: 'Account number to search' })
  @IsOptional()
  @IsString()
  accountNumber?: string;

  @ApiPropertyOptional({ description: 'Status filter' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Date from (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Date to (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({ description: 'Minimum amount' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  amountFrom?: number;

  @ApiPropertyOptional({ description: 'Maximum amount' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  amountTo?: number;

  @ApiPropertyOptional({ description: 'Loan type filter' })
  @IsOptional()
  @IsString()
  loanType?: string;

  @ApiPropertyOptional({ description: 'Member IDs to filter', type: [Number] })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  memberIds?: number[];

  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number = 10;
}

export enum SearchEntityType {
  MEMBER = 'member',
  LOAN = 'loan',
  DEPOSIT = 'deposit',
  TRANSACTION = 'transaction',
  ALL = 'all'
}

export class GlobalSearchDto {
  @ApiPropertyOptional({ description: 'Search query' })
  @IsOptional()
  @IsString()
  query?: string;

  @ApiPropertyOptional({ 
    description: 'Entity type to search',
    enum: SearchEntityType,
    default: SearchEntityType.ALL
  })
  @IsOptional()
  @IsEnum(SearchEntityType)
  entityType?: SearchEntityType = SearchEntityType.ALL;

  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number = 10;
}

export interface SearchResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface GlobalSearchResult {
  members: SearchResult<any>;
  loans: SearchResult<any>;
  deposits: SearchResult<any>;
  transactions: SearchResult<any>;
  totalResults: number;
}
