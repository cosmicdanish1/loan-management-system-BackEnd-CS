import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AppService } from './app.service';
import { Public } from './modules/auth/decorators/public.decorator';

@ApiTags('Application')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Get application information' })
  @ApiResponse({ status: 200, description: 'Application information retrieved successfully' })
  getHello(): object {
    return this.appService.getAppInfo();
  }

  // Polled unauthenticated by health-check.js — must stay public.
  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Health check endpoint' })
  @ApiResponse({ status: 200, description: 'Application is healthy' })
  getHealth(): object {
    return this.appService.getHealthCheck();
  }
}
