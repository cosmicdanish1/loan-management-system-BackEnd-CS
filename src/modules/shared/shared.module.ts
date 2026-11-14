import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SequenceGeneratorService, PasswordHistoryService } from './services';
import { SequenceMaster } from './entities/sequence-master.entity';

/**
 * Shared Module - Provides centralized services used across the application.
 * 
 * This module is marked as @Global so its exports are available everywhere
 * without needing to import SharedModule in each feature module.
 * 
 * @version 2.0 - Part of backend restructuring
 */
@Global()
@Module({
    imports: [
        TypeOrmModule.forFeature([SequenceMaster])
    ],
    providers: [SequenceGeneratorService, PasswordHistoryService],
    exports: [SequenceGeneratorService, PasswordHistoryService],
})
export class SharedModule { }
