import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MemberController } from './member.controller';
import { MemberService } from './member.service';
import { SignatureService } from './services/signature.service';
import { Member } from './entities/member.entity';
import { MemberMaster } from './entities/member-master.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Member, MemberMaster])],
  controllers: [MemberController],
  providers: [MemberService, SignatureService],
  exports: [MemberService, SignatureService],
})
export class MemberModule {}
