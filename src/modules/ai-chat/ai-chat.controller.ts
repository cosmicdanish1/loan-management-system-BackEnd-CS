import { Controller, Get, Post, Body, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RoleGuard } from '../auth/guards/role.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user.entity';
import { AiChatService } from './ai-chat.service';
import { KnowledgeService } from './knowledge.service';

// Staff assistant: every call needs a signed-in employee (ES-439), so limits and the log are per person.
@ApiTags('AI Chat')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ai-chat')
export class AiChatController {
  constructor(
    private readonly aiChatService: AiChatService,
    private readonly knowledge?: KnowledgeService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Chat with AI assistant' })
  async chat(@Body() body: { messages: Array<{ role: string; content: string }>; route?: string }, @Req() req?: any) {
    const user = req?.user;
    return this.aiChatService.chat(body?.messages || [], {
      userId: user?.id != null ? String(user.id) : undefined,
      username: user?.susername || user?.username,
      role: user?.role?.name || user?.role || user?.userLevel,
      route: typeof body?.route === 'string' ? body.route : undefined,
    });
  }

  // Same as POST /ai-chat but the answer arrives piece by piece (server-sent events), so a slow provider
  // shows words at once instead of a spinner. Events: {type:'delta',text} ... then one {type:'done', ...result}.
  // Rate-limit errors are thrown before any byte is written, so the browser still gets a normal HTTP 429.
  @Post('stream')
  @ApiOperation({ summary: 'Chat with AI assistant, streamed (text/event-stream)' })
  async stream(@Body() body: { messages: Array<{ role: string; content: string }>; route?: string }, @Req() req: any, @Res() res: Response) {
    const user = req?.user;
    let started = false;
    const write = (obj: unknown) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
      (res as any).flush?.(); // the compression middleware buffers unless flushed
    };
    const begin = () => {
      if (started) return;
      started = true;
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
    };
    const ctx = {
      userId: user?.id != null ? String(user.id) : undefined,
      username: user?.susername || user?.username,
      role: user?.role?.name || user?.role || user?.userLevel,
      route: typeof body?.route === 'string' ? body.route : undefined,
    };
    try {
      const result = await this.aiChatService.chat(body?.messages || [], ctx, (text) => {
        begin();
        write({ type: 'delta', text });
      });
      begin();
      write({ type: 'done', ...result });
    } catch (err: any) {
      if (!started) {
        // nothing sent yet: answer like any other endpoint (429 for the rate limit, 500 otherwise)
        const status = typeof err?.getStatus === 'function' ? err.getStatus() : 500;
        res.status(status).json({ statusCode: status, message: err?.message || 'AI chat failed' });
        return;
      }
      write({ type: 'error', message: 'The answer was interrupted. Please ask again.' });
    }
    res.end();
  }

  @Get('health')
  @ApiOperation({ summary: 'Provider setup and 24-hour numbers for the assistant (no question text)' })
  async health() {
    return this.aiChatService.health();
  }

  // Questions staff type can contain member details, so the review list is for administrators only.
  @Get('logs')
  @UseGuards(RoleGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Recent assistant questions and answers (administrators). filter = failed | down | up' })
  async logs(@Query('filter') filter?: string, @Query('limit') limit?: string) {
    return this.aiChatService.listLogs(filter, Number(limit) || 50);
  }

  // Re-reads backend/knowledge and the documentation folder, so an edited guide is live without a restart.
  @Post('knowledge/reload')
  @UseGuards(RoleGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Re-index the assistant documents (administrators)' })
  async reloadKnowledge() {
    return this.knowledge ? this.knowledge.reload() : { files: 0, chunks: 0 };
  }

  @Post('feedback')
  @ApiOperation({ summary: 'Rate an assistant answer: value 1 = helpful, -1 = not helpful' })
  async feedback(@Body() body: { logId: number; value: number }, @Req() req?: any) {
    const user = req?.user;
    const ok = await this.aiChatService.setFeedback(Number(body?.logId), Number(body?.value), user?.susername || user?.username);
    return { saved: ok };
  }
}
