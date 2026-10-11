import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SupportQuery } from './entities/support-query.entity';
import { SupportQueryService } from './services/support-query.service';
import { JiraClientService } from './services/jira-client.service';
import { SupportQueryController } from './controllers/support-query.controller';

@Module({
    imports: [TypeOrmModule.forFeature([SupportQuery])],
    controllers: [SupportQueryController],
    providers: [SupportQueryService, JiraClientService],
    exports: [SupportQueryService],
})
export class SupportModule { }
