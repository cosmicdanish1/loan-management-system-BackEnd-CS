import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Member } from './entities/member.entity';
import { MemberMaster } from './entities/member-master.entity';
import { MemberCrudService, MemberLookupService, MemberBalanceService, SignatureService } from './services-v2';
import { MemberV2Controller } from './member-v2.controller';

import { AdminModule } from '../admin/admin.module';
import { RdModule } from '../rd/rd.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([Member, MemberMaster]),
        AdminModule,
        RdModule,
    ],
    controllers: [MemberV2Controller],
    providers: [
        MemberCrudService,
        MemberLookupService,
        MemberBalanceService,
        SignatureService,
    ],
    exports: [
        MemberCrudService,
        MemberLookupService,
        MemberBalanceService,
        SignatureService,
    ],
})
export class MemberV2Module { }
