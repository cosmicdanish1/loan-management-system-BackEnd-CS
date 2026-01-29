import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SequenceGeneratorService } from './services';
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
    providers: [SequenceGeneratorService],
    exports: [SequenceGeneratorService],
})
export class SharedModule { }
