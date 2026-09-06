import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { NoticeService } from '../services/notice.service';
import { DashboardNoticeType } from '../entities/dashboard-notice.entity';

@ApiTags('Dashboard Notices')
@Controller('dashboard-notices')
export class NoticeController {
    constructor(private readonly noticeService: NoticeService) { }

    @ApiOperation({ summary: 'List all dashboard notices, shared across every PC' })
    @Get()
    async findAll() {
        return this.noticeService.findAll();
    }

    @ApiOperation({ summary: 'Post a new dashboard notice' })
    @Post()
    async create(@Body() data: {
        title: string;
        message: string;
        type: DashboardNoticeType;
        postedBy: string;
    }) {
        return this.noticeService.create(data);
    }

    // 4.4 fix: a missing/malformed body crashed with 500 "Cannot read properties
    // of undefined (reading 'map')" inside reorder() — confirmed live with {} body.
    @ApiOperation({ summary: 'Persist a new drag-and-drop order for the board' })
    @Put('reorder')
    async reorder(@Body() data: { orderedIds: number[] }) {
        if (!Array.isArray(data?.orderedIds)) {
            throw new BadRequestException('orderedIds must be an array of notice ids');
        }
        await this.noticeService.reorder(data.orderedIds);
        return { success: true };
    }

    @ApiOperation({ summary: 'Delete a dashboard notice' })
    @Delete(':id')
    async remove(@Param('id', ParseIntPipe) id: number) {
        await this.noticeService.remove(id);
        return { success: true };
    }
}
