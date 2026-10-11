import {
    BadRequestException,
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Query,
    Req,
    Res,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { LoanReagreementService, ReagreementContext } from './services-v2/reagreement/loan-reagreement.service';

/**
 * Re-agreement (loan restructure) endpoints. Unlike the older loan controller this one is
 * authenticated from day one. Passing and reversing go through the existing Pass Transactions
 * endpoints; sanction and the voucher step go through the existing Sanction / Loan Payment endpoints.
 */
@ApiTags('Loan Re-agreement')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('loans/reagreement')
export class LoanReagreementController {
    constructor(private readonly service: LoanReagreementService) { }

    private ctx(req: Request): ReagreementContext {
        const user: any = (req as any).user;
        return {
            actor: user?.username || 'system',
            ip: (req.headers['x-forwarded-for'] as string) || req.ip,
            requestId: (req.headers['x-request-id'] as string) || undefined,
        };
    }

    @Get('member/:mbno/loans')
    @ApiOperation({ summary: 'Active loans of a member that can be re-agreed' })
    activeLoans(@Param('mbno') mbno: string) {
        return this.service.activeLoans(mbno);
    }

    @Get('eligibility/:caseNo')
    @ApiOperation({ summary: 'Is this loan eligible for a re-agreement (hard checks + Business Rules)?' })
    eligibility(@Param('caseNo') caseNo: string, @Query('mbno') mbno: string, @Query('loantype') loantype?: string) {
        if (!mbno) throw new BadRequestException('mbno is required');
        return this.service.eligibility(mbno, caseNo, loantype);
    }

    @Post('quote')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Read-only quote: all figures of the new agreement (nothing is saved)' })
    quote(@Body() body: any) {
        return this.service.buildQuote({
            mbno: String(body.mbno || ''), loancaseno: String(body.loancaseno || ''), loantype: body.loantype || undefined,
            newInstallments: Number(body.newInstallments), newRate: Number(body.newRate), applicationDate: body.applicationDate || undefined,
        }, { excludeReagreementId: body.reagreementId || undefined });
    }

    @Post('apply')
    @ApiOperation({ summary: 'Apply for a re-agreement: creates the pending case and the re-agreement record' })
    apply(@Body() body: any, @Req() req: Request) {
        return this.service.apply({
            mbno: String(body.mbno || ''), loancaseno: String(body.loancaseno || ''), loantype: body.loantype || undefined,
            newInstallments: Number(body.newInstallments), newRate: Number(body.newRate), applicationDate: body.applicationDate || undefined,
            reason: body.reason || '',
        }, this.ctx(req));
    }

    @Get('open')
    @ApiOperation({ summary: 'Open (not yet passed or cancelled) re-agreements' })
    listOpen(@Query('mbno') mbno?: string) {
        return this.service.listOpen(mbno);
    }

    @Get('history/:mbno/:caseNo')
    @ApiOperation({ summary: 'Chain of cases and re-agreements around a loan case' })
    history(@Param('mbno') mbno: string, @Param('caseNo') caseNo: string, @Query('loantype') loantype?: string) {
        return this.service.history(mbno, caseNo, loantype);
    }

    @Get('by-case/:caseNo')
    @ApiOperation({ summary: 'Re-agreement that created (or is creating) a new loan case' })
    byCase(@Param('caseNo') caseNo: string, @Query('mbno') mbno?: string) {
        return this.service.getByNewCase(caseNo, mbno);
    }

    @Get(':id')
    @ApiOperation({ summary: 'One re-agreement' })
    getOne(@Param('id') id: string) {
        return this.service.getById(id);
    }

    @Get(':id/log')
    @ApiOperation({ summary: 'Event log of a re-agreement' })
    log(@Param('id') id: string) {
        return this.service.getLog(id);
    }

    @Post(':id/cancel')
    @ApiOperation({ summary: 'Cancel an open re-agreement (before it is passed)' })
    cancel(@Param('id') id: string, @Body() body: any, @Req() req: Request) {
        return this.service.cancel(id, body?.reason || '', this.ctx(req));
    }

    @Get(':id/draft')
    @ApiOperation({ summary: 'Watermarked DRAFT agreement for signing before pass (generated, not stored)' })
    async draft(@Param('id') id: string, @Query('format') format: string = 'pdf', @Res() res: Response) {
        const d = await this.service.renderDraft(id);
        this.send(res, format, d.text, d.pdf, d.png, `RE-AGREEMENT-DRAFT-${id}`);
    }

    @Get(':id/document')
    @ApiOperation({ summary: 'The saved (issued) agreement as text, PDF or image' })
    async document(@Param('id') id: string, @Req() req: Request, @Res() res: Response,
        @Query('format') format: string = 'pdf', @Query('issue') issue?: string) {
        const kind = format === 'png' || format === 'image' ? 'png' : format === 'text' || format === 'txt' ? 'text' : 'pdf';
        const d = await this.service.getIssuedDocument(id, kind, this.ctx(req), issue ? Number(issue) : undefined);
        this.send(res, kind, d.text, kind === 'pdf' ? d.bytes : null, kind === 'png' ? d.bytes : null, `RE-AGREEMENT-${id}-copy${d.issueNo}`);
    }

    private send(res: Response, format: string, text: string, pdf: Buffer | null, png: Buffer | null, name: string) {
        if (format === 'png' || format === 'image') {
            if (!png) throw new BadRequestException('Image copy not available');
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Content-Disposition', `inline; filename="${name}.png"`);
            res.send(png);
        } else if (format === 'text' || format === 'txt') {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.send(text);
        } else {
            if (!pdf) throw new BadRequestException('PDF copy not available');
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `inline; filename="${name}.pdf"`);
            res.send(pdf);
        }
    }
}
