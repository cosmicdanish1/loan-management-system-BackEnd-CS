import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Exclude, Expose, Transform } from 'class-transformer';

export class MemberResponseDto {
  @ApiProperty({
    description: 'Unique identifier for the member',
    example: 1,
  })
  @Expose()
  id: number;

  @ApiProperty({
    description: 'Unique member number',
    example: 'MEM001',
  })
  @Expose()
  memberNumber: string;

  @ApiProperty({
    description: 'First name of the member',
    example: 'John',
  })
  @Expose()
  firstName: string;

  @ApiProperty({
    description: 'Last name of the member',
    example: 'Doe',
  })
  @Expose()
  lastName: string;

  @ApiProperty({
    description: 'Full name of the member',
    example: 'John Doe',
  })
  @Expose()
  @Transform(({ obj }) => `${obj.firstName} ${obj.lastName}`)
  fullName: string;

  @ApiProperty({
    description: 'Date of birth',
    example: '1990-01-15',
  })
  @Expose()
  dateOfBirth: Date;

  @ApiProperty({
    description: 'Complete address',
    example: '123 Main Street, City, State - 123456',
  })
  @Expose()
  address: string;

  @ApiProperty({
    description: 'Phone number',
    example: '+919876543210',
  })
  @Expose()
  phoneNumber: string;

  @ApiPropertyOptional({
    description: 'Email address',
    example: 'john.doe@example.com',
  })
  @Expose()
  email?: string;

  @ApiPropertyOptional({
    description: 'Aadhar number',
    example: '123456789012',
  })
  @Expose()
  aadharNumber?: string;

  @ApiPropertyOptional({
    description: 'PAN number',
    example: 'ABCDE1234F',
  })
  @Expose()
  panNumber?: string;

  @ApiPropertyOptional({
    description: 'Occupation',
    example: 'Software Engineer',
  })
  @Expose()
  occupation?: string;

  @ApiProperty({
    description: 'Share amount',
    example: 1000.00,
  })
  @Expose()
  shareAmount: number;

  @ApiPropertyOptional({
    description: 'Path to signature image',
    example: '/uploads/signatures/member_1_signature.jpg',
  })
  @Expose()
  signatureImagePath?: string;

  @ApiProperty({
    description: 'Member status',
    example: 'ACTIVE',
  })
  @Expose()
  status: string;

  @ApiProperty({
    description: 'Creation timestamp',
    example: '2024-01-15T10:30:00Z',
  })
  @Expose()
  createdAt: Date;

  @ApiProperty({
    description: 'Last update timestamp',
    example: '2024-01-15T10:30:00Z',
  })
  @Expose()
  updatedAt: Date;

  constructor(partial: Partial<MemberResponseDto>) {
    Object.assign(this, partial);
  }
}
