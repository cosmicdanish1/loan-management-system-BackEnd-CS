import { Injectable } from '@nestjs/common';

@Injectable()
export class ReportService {
  async findAll() {
    return { message: 'Report service - To be implemented' };
  }
}
