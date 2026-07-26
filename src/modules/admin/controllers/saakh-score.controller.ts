import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { SaakhScoreService } from '../services/saakh-score.service';

@ApiTags('Administration')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin')
export class SaakhScoreController {
  constructor(private readonly saakhScoreService: SaakhScoreService) {}

  @Get('saakh-score/:mbno')
  @ApiOperation({ summary: 'Calculate Saakh Score (member financial health index 0-10) for a member' })
  @ApiParam({ name: 'mbno', description: 'Member number (mbno)' })
  async getSaakhScore(@Param('mbno') mbno: string) {
    return this.saakhScoreService.calculateSaakhScore(mbno);
  }
}
