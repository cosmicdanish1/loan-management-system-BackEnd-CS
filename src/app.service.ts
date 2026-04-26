import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getAppInfo(): object {
    return {
      name: 'Paper White Technology - LMS API',
      version: '1.0.0',
      description: 'Comprehensive backend API for Paper White Technology LMS',
      author: 'Paper White Technology',
      documentation: '/api/docs',
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString(),
      status: 'running',
    };
  }

  getHealthCheck(): object {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
    };
  }
}
