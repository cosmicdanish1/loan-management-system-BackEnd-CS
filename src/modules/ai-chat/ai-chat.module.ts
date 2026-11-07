import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiChatController } from './ai-chat.controller';
import { AiChatService } from './ai-chat.service';
import { AiChatLog } from './entities/ai-chat-log.entity';
import { KnowledgeService } from './knowledge.service';

@Module({
  imports: [TypeOrmModule.forFeature([AiChatLog])],
  controllers: [AiChatController],
  providers: [AiChatService, KnowledgeService],
  exports: [AiChatService, KnowledgeService],
})
export class AiChatModule {}
