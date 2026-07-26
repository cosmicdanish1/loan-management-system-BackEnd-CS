import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AiChatService } from './ai-chat.service';

@ApiTags('AI Chat')
@Controller('ai-chat')
export class AiChatController {
  constructor(private readonly aiChatService: AiChatService) {}

  @Post()
  @ApiOperation({ summary: 'Chat with AI assistant' })
  async chat(@Body() body: { messages: Array<{ role: string; content: string }> }) {
    const result = await this.aiChatService.chat(body.messages || []);
    return result;
  }
}
