import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** Allowed member lifecycle states (member.status). */
export const MEMBER_STATUSES = [
  'ACTIVE',
  'INACTIVE',
  'SUSPENDED',
  'RESIGNED',
  'EXPIRED',
  'CLOSED',
] as const;

export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export class UpdateMemberStatusDto {
  @ApiProperty({
    description: 'New member lifecycle status',
    enum: MEMBER_STATUSES,
    example: 'INACTIVE',
  })
  @IsIn(MEMBER_STATUSES, {
    message: `status must be one of: ${MEMBER_STATUSES.join(', ')}`,
  })
  status: MemberStatus;

  @ApiProperty({
    description: 'Optional reason/note for the status change (for audit)',
    required: false,
    example: 'Member resigned from the society',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
