import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { EasterEggsService } from './easter-eggs.service';

class FoundEggDto {
    @IsString()
    @MaxLength(32)
    egg!: string;
}

@ApiTags('Easter eggs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('easter-eggs')
export class EasterEggsController {
    constructor(private readonly service: EasterEggsService) { }

    private who(req: any): { id: string; name: string } {
        const u = req.user ?? {};
        return { id: String(u.id), name: String(u.fullName ?? u.name ?? u.username ?? u.userName ?? u.id) };
    }

    @Get('me')
    @ApiOperation({ summary: 'Easter-egg hunt progress of the signed-in user' })
    async me(@Req() req: any) {
        return { success: true, data: await this.service.get(this.who(req).id) };
    }

    @Post('found')
    @ApiOperation({ summary: 'Record that the signed-in user found an Easter egg' })
    async found(@Req() req: any, @Body() dto: FoundEggDto) {
        const w = this.who(req);
        return { success: true, data: await this.service.markFound(w.id, w.name, dto.egg) };
    }
}
