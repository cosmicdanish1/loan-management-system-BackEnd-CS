import { IsString, IsNotEmpty } from 'class-validator';

export class MemberProfileDto {
    @IsString()
    @IsNotEmpty()
    memberNo: string;
}
