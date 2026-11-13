import { BadRequestException, Body, Controller, Delete, Get, ForbiddenException, Param, ParseIntPipe, Post, Put, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { NoticeService, NOTE_COLORS, type NoticeViewer } from '../services/notice.service';
import { DashboardNoticeType } from '../entities/dashboard-notice.entity';
import { isAdminUser } from '../../auth/twofa/manage.guard';

// The signed-in user, never a name sent by the screen (ES-434).
const viewerOf = (req: any): NoticeViewer => ({
    username: String(req?.user?.username ?? 'unknown').slice(0, 100),
    isAdmin: isAdminUser(req?.user),
});

@ApiTags('Dashboard Notices')
@Controller('dashboard-notices')
export class NoticeController {
    constructor(private readonly noticeService: NoticeService) { }

    @ApiOperation({ summary: 'Notices everyone sees, plus the signed-in user\'s own private notes' })
    @Get()
    async findAll(@Req() req?: any) {
        return this.noticeService.findAll(viewerOf(req));
    }

    @ApiOperation({ summary: 'What the signed-in user may do on the notice board' })
    @Get('access')
    async access(@Req() req?: any) {
        const viewer = viewerOf(req);
        return { username: viewer.username, isAdmin: viewer.isAdmin, colors: NOTE_COLORS };
    }

    @ApiOperation({ summary: 'Post a new dashboard notice' })
    @Post()
    async create(@Body() data: {
        title: string;
        message: string;
        type: DashboardNoticeType;
        postedBy?: string;
        showOnMobile?: boolean;
        audienceWing?: string | null;
        audienceOffice?: number | null;
        isPrivate?: boolean;
        isImportant?: boolean;
        color?: string | null;
    }, @Req() req?: any) {
        // Checked here so a bad body is a 400, not a database error (ES-371)
        const title = typeof data?.title === 'string' ? data.title.trim() : '';
        const message = typeof data?.message === 'string' ? data.message.trim() : '';
        if (!title) throw new BadRequestException('title is required');
        if (title.length > 200) throw new BadRequestException('title can be at most 200 characters');
        if (!message) throw new BadRequestException('message is required');
        if (!Object.values(DashboardNoticeType).includes(data.type)) {
            throw new BadRequestException(`type must be one of: ${Object.values(DashboardNoticeType).join(', ')}`);
        }
        // Audience only means something for notices that go to phones; a staff-only notice never carries one (ES-388)
        const showOnMobile = data.showOnMobile === true;
        let audienceWing: string | null = null;
        let audienceOffice: number | null = null;
        if (showOnMobile) {
            if (data.audienceWing != null && data.audienceWing !== '') {
                if (typeof data.audienceWing !== 'string' || data.audienceWing.trim().length > 5) {
                    throw new BadRequestException('audienceWing must be a wing number of at most 5 characters');
                }
                audienceWing = data.audienceWing.trim();
            }
            if (data.audienceOffice != null) {
                if (!audienceWing) throw new BadRequestException('audienceOffice needs an audienceWing');
                if (!Number.isInteger(data.audienceOffice) || data.audienceOffice < 0) {
                    throw new BadRequestException('audienceOffice must be a whole office number');
                }
                audienceOffice = data.audienceOffice;
            }
        } else if (data.audienceWing != null || data.audienceOffice != null) {
            throw new BadRequestException('an audience can only be set when showOnMobile is true');
        }
        const viewer = viewerOf(req);
        const isPrivate = data.isPrivate === true;
        const isImportant = data.isImportant === true;
        if (isImportant && !viewer.isAdmin) throw new ForbiddenException('Only an administrator can mark a notice as important');
        if (isPrivate && isImportant) throw new BadRequestException('a private note cannot be important');
        if (isPrivate && showOnMobile) throw new BadRequestException('a private note cannot be shown on the mobile app');
        let color: string | null = null;
        if (data.color != null && data.color !== '') {
            if (!(NOTE_COLORS as readonly string[]).includes(data.color)) {
                throw new BadRequestException(`color must be one of: ${NOTE_COLORS.join(', ')}`);
            }
            color = data.color;
        }
        return this.noticeService.create({
            title, message, type: data.type, postedBy: viewer.username,
            showOnMobile, audienceWing, audienceOffice, isPrivate, isImportant, color,
        }, viewer);
    }

    @ApiOperation({ summary: 'Publish a private note to everyone, or take your own notice back to private' })
    @Put(':id/visibility')
    async setVisibility(@Param('id', ParseIntPipe) id: number, @Body() data: { isPrivate: boolean }, @Req() req?: any) {
        if (typeof data?.isPrivate !== 'boolean') throw new BadRequestException('isPrivate must be true or false');
        return this.noticeService.setPrivate(id, data.isPrivate, viewerOf(req));
    }

    // 4.4 fix: a missing/malformed body crashed with 500 "Cannot read properties
    // of undefined (reading 'map')" inside reorder() — confirmed live with {} body.
    @ApiOperation({ summary: 'Persist a new drag-and-drop order for the board' })
    @Put('reorder')
    async reorder(@Body() data: { orderedIds: number[] }) {
        if (!Array.isArray(data?.orderedIds)) {
            throw new BadRequestException('orderedIds must be an array of notice ids');
        }
        if (data.orderedIds.some((id) => !Number.isInteger(id))) {
            throw new BadRequestException('orderedIds must contain whole numbers only');
        }
        await this.noticeService.reorder(data.orderedIds);
        return { success: true };
    }

    @ApiOperation({ summary: 'Delete a dashboard notice' })
    @Delete(':id')
    async remove(@Param('id', ParseIntPipe) id: number, @Req() req?: any) {
        await this.noticeService.remove(id, viewerOf(req));
        return { success: true };
    }
}
