import { Body, Controller, Post, Request } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireMenuAction } from '../auth/guards/menu-right.guard';
import { MemberBalanceTransferService } from './services-v2/member-balance-transfer.service';
import { GenerateMemberBalanceTransferDto, PostMemberBalanceTransferDto } from './dto/member-balance-transfer.dto';

/**
 * ES-511: the Member Balance Transfer window calls these two routes, but the service was never given a controller
 * (and was not a provider of any module), so both answered 404.
 */
@ApiTags('Member Balance Transfer')
@Controller('transactions/member-balance-transfer')
export class MemberBalanceTransferController {
    constructor(private readonly transferService: MemberBalanceTransferService) { }

    @Post('generate')
    @RequireMenuAction('MEMBER_BALANCE_TRANSFER')
    @ApiOperation({ summary: 'Preview the member-wise transfer between two heads (nothing is posted)' })
    async generate(@Body() dto: GenerateMemberBalanceTransferDto) {
        return this.transferService.generate(dto.debitHead, dto.creditHead, dto.creditLimit, dto.excessHead ?? '', dto.balanceAsOn);
    }

    @Post('post')
    @RequireMenuAction('MEMBER_BALANCE_TRANSFER')
    @ApiOperation({ summary: 'Post the member-wise transfer to the ledger (amounts are recomputed on the server)' })
    async post(@Body() dto: PostMemberBalanceTransferDto, @Request() req: any) {
        // The acting user comes from the token, never from the request body.
        const postedBy = req.user?.username || 'admin';
        return this.transferService.post(
            dto.entries as any,
            dto.debitHead,
            dto.creditHead,
            dto.excessHead ?? '',
            postedBy,
            dto.creditLimit ?? 999999999,
            dto.balanceAsOn ?? new Date().toISOString().split('T')[0],
        );
    }
}
