import {
    BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RoleGuard } from '../../auth/guards/role.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { UserRole } from '../../auth/entities/user.entity';
import { SupportQueryService, Reporter } from '../services/support-query.service';
import { CreateSupportQueryDto } from '../dto/create-support-query.dto';

const screenshotUpload = {
    storage: diskStorage({
        destination: './uploads/support',
        filename: (_req, file, cb) => {
            // Server-generated name only: never reuse the client's filename in the path.
            const ext = ['.png', '.jpg', '.jpeg'].includes(extname(file.originalname).toLowerCase())
                ? extname(file.originalname).toLowerCase() : '.png';
            cb(null, `SQ_${Date.now()}_${Math.round(Math.random() * 1e6)}${ext}`);
        },
    }),
    limits: { fileSize: 3 * 1024 * 1024, files: 1 },
    fileFilter: (_req: any, file: Express.Multer.File, cb: any) => {
        if (!['image/png', 'image/jpeg', 'image/jpg'].includes(file.mimetype)) {
            return cb(new BadRequestException('Only PNG or JPEG screenshots are allowed'), false);
        }
        cb(null, true);
    },
};

function reporterOf(req: any): Reporter {
    const u = req.user || {};
    const role = String(u.role || '').toLowerCase();
    return {
        userId: u.userid ?? u.id ?? null,
        username: u.username ?? null,
        role: u.role ?? null,
        isAdmin: role === UserRole.ADMIN || role === UserRole.SYSTEM,
    };
}

// Any logged-in user may raise and track their OWN queries; list-all and retry are admin only.
@ApiTags('Support Queries')
@Controller('support-queries')
@UseGuards(JwtAuthGuard, RoleGuard)
export class SupportQueryController {
    constructor(private readonly service: SupportQueryService) { }

    @ApiOperation({ summary: 'Raise a query (optional screenshot); saved, then sent to Jira + Telegram' })
    @Post()
    @UseInterceptors(FileInterceptor('screenshot', screenshotUpload))
    async create(@Body() dto: CreateSupportQueryDto, @UploadedFile() file: Express.Multer.File, @Req() req: any) {
        const q = await this.service.create(dto, reporterOf(req), file?.path);
        return { id: q.id, ticketNo: `SQ-${String(q.id).padStart(5, '0')}`, status: q.status, createdAt: q.createdAt };
    }

    @Get('mine')
    mine(@Req() req: any) {
        return this.service.listMine(reporterOf(req).username || '');
    }

    @Get('admin/all')
    @Roles(UserRole.ADMIN)
    all(@Query('status') status?: string) {
        return this.service.listAll(status);
    }

    @Get(':id')
    one(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
        return this.service.getOne(id, reporterOf(req));
    }

    @Post(':id/retry')
    @Roles(UserRole.ADMIN)
    retry(@Param('id', ParseIntPipe) id: number) {
        return this.service.retry(id);
    }
}
