import {
  BadRequestException, Controller, Delete, Get, Post, Req, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { mkdirSync } from 'fs';
import { extname } from 'path';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RoleGuard } from '../auth/guards/role.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user.entity';
import { INCOMING_DIR, SystemUpdateService } from './system-update.service';

const releaseUpload = {
  storage: diskStorage({
    destination: (_req: any, _file: any, cb: any) => {
      mkdirSync(INCOMING_DIR, { recursive: true });
      cb(null, INCOMING_DIR);
    },
    // Server-generated name only: never reuse the client's filename in the path.
    filename: (_req: any, _file: any, cb: any) => cb(null, `release-${Date.now()}.zip`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 },
  fileFilter: (_req: any, file: Express.Multer.File, cb: any) => {
    if (extname(file.originalname).toLowerCase() !== '.zip') {
      return cb(new BadRequestException('Only a .zip release file is allowed'), false);
    }
    cb(null, true);
  },
};

const who = (req: any): string => req.user?.username ?? req.user?.userName ?? 'unknown';

// Server software updates. Administrators only: applying a release restarts the server.
@ApiTags('System Update')
@Controller('system-update')
@UseGuards(JwtAuthGuard, RoleGuard)
@Roles(UserRole.ADMIN)
export class SystemUpdateController {
  constructor(private readonly svc: SystemUpdateService) {}

  @ApiOperation({ summary: 'Installed version, whether self-update is possible, waiting release, last update result' })
  @Get('status')
  status() {
    return this.svc.getStatus();
  }

  @ApiOperation({ summary: 'Upload a backend release zip. Validated and staged; nothing is changed yet.' })
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', releaseUpload))
  async upload(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    if (!file) throw new BadRequestException('Attach the release zip as "file".');
    return this.svc.stage(file.path, who(req));
  }

  @ApiOperation({ summary: 'Ask GitHub whether a newer published backend release exists' })
  @Get('remote/check')
  checkRemote() {
    return this.svc.checkRemote();
  }

  @ApiOperation({ summary: 'Download the newest release from GitHub (background), then stage it like an upload' })
  @Post('remote/download')
  downloadRemote(@Req() req: any) {
    return this.svc.startRemoteDownload(who(req));
  }

  @ApiOperation({ summary: 'Progress of the running download' })
  @Get('remote/progress')
  progress() {
    return this.svc.getDownloadProgress();
  }

  @ApiOperation({ summary: 'Apply the staged release: backup, replace files, migrate, restart, verify (rolls back on failure)' })
  @Post('apply')
  apply(@Req() req: any) {
    return this.svc.apply(who(req));
  }

  @ApiOperation({ summary: 'Discard the staged release' })
  @Delete('pending')
  discard() {
    return this.svc.discardPending();
  }
}
