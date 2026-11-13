import { ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DashboardNotice } from '../entities/dashboard-notice.entity';

/** Who is asking: the signed-in user's name and whether they are an administrator. */
export interface NoticeViewer { username: string; isAdmin: boolean }

export const NOTE_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple'] as const;

/**
 * The dashboard notice board and personal sticky notes, in one table.
 *
 *  - Notice (is_private = false): every user sees it. Anyone may post one.
 *  - Important notice (is_important = true): posted by an administrator; always listed first.
 *  - Private note (is_private = true): only its author sees it. The author may publish it (it becomes
 *    an ordinary notice) or take their own notice back to private.
 *  - A notice or note is changed or deleted by its author or by an administrator, nobody else.
 */
@Injectable()
export class NoticeService implements OnModuleInit {
    private readonly logger = new Logger(NoticeService.name);

    constructor(
        @InjectRepository(DashboardNotice)
        private readonly noticeRepository: Repository<DashboardNotice>,
    ) { }

    // The columns for private notes are added here as well as in the migration: several installs have a
    // migrations table that is out of step, and the board must not break on them.
    async onModuleInit() {
        try {
            await this.noticeRepository.query(`ALTER TABLE "dashboard_notices" ADD COLUMN IF NOT EXISTS "is_private" boolean NOT NULL DEFAULT false`);
            await this.noticeRepository.query(`ALTER TABLE "dashboard_notices" ADD COLUMN IF NOT EXISTS "is_important" boolean NOT NULL DEFAULT false`);
            await this.noticeRepository.query(`ALTER TABLE "dashboard_notices" ADD COLUMN IF NOT EXISTS "color" varchar(12)`);
        } catch (e: any) {
            this.logger.warn(`Could not prepare dashboard_notices for private notes: ${e.message}`);
        }
    }

    private present(n: DashboardNotice, viewer: NoticeViewer) {
        const mine = n.postedBy === viewer.username;
        return { ...n, mine, canManage: mine || viewer.isAdmin };
    }

    /** Everything this user may see: all notices plus their own private notes. Important first. */
    async findAll(viewer: NoticeViewer) {
        const rows = await this.noticeRepository
            .createQueryBuilder('n')
            .where('n.is_private = false OR n.posted_by = :u', { u: viewer.username })
            .orderBy('n.is_important', 'DESC')
            .addOrderBy('n.sort_order', 'ASC')
            .addOrderBy('n.created_at', 'DESC')
            .getMany();
        return rows.map(n => this.present(n, viewer));
    }

    async create(data: {
        title: string;
        message: string;
        type: DashboardNotice['type'];
        postedBy: string;
        showOnMobile?: boolean;
        audienceWing?: string | null;
        audienceOffice?: number | null;
        isPrivate?: boolean;
        isImportant?: boolean;
        color?: string | null;
    }, viewer: NoticeViewer) {
        // New notices float to the top by default (lower sortOrder = first),
        // same feel as the old "newest first" localStorage list.
        const { minSortOrder } = await this.noticeRepository
            .createQueryBuilder('n')
            .select('MIN(n.sort_order)', 'minSortOrder')
            .getRawOne<{ minSortOrder: number | null }>() ?? { minSortOrder: null };

        const notice = this.noticeRepository.create({
            ...data,
            sortOrder: (minSortOrder ?? 1) - 1,
        });
        return this.present(await this.noticeRepository.save(notice), viewer);
    }

    private async ownOrAdmin(id: number, viewer: NoticeViewer): Promise<DashboardNotice> {
        const notice = await this.noticeRepository.findOne({ where: { id } });
        // Someone else's private note is reported as missing, so its existence is not revealed.
        if (!notice || (notice.isPrivate && notice.postedBy !== viewer.username)) {
            throw new NotFoundException(`Notice ${id} not found`);
        }
        if (notice.postedBy !== viewer.username && !viewer.isAdmin) {
            throw new ForbiddenException('Only the person who posted this notice, or an administrator, can change it');
        }
        return notice;
    }

    /** Publish a private note to everyone, or take a notice back to private. Author only. */
    async setPrivate(id: number, isPrivate: boolean, viewer: NoticeViewer) {
        const notice = await this.ownOrAdmin(id, viewer);
        if (notice.postedBy !== viewer.username) {
            throw new ForbiddenException('Only the person who wrote a note can publish it or make it private');
        }
        notice.isPrivate = isPrivate;
        if (isPrivate) {
            // A private note is never important and never goes to phones.
            notice.isImportant = false;
            notice.showOnMobile = false;
            notice.audienceWing = null;
            notice.audienceOffice = null;
        }
        return this.present(await this.noticeRepository.save(notice), viewer);
    }

    // Body is the full board order after a drag — cheaper and less racy than
    // computing a diff, and the board never holds enough rows for N updates
    // to matter.
    async reorder(orderedIds: number[]): Promise<void> {
        await Promise.all(
            orderedIds.map((id, index) =>
                this.noticeRepository.update({ id }, { sortOrder: index }),
            ),
        );
    }

    async remove(id: number, viewer: NoticeViewer): Promise<void> {
        const notice = await this.ownOrAdmin(id, viewer);
        await this.noticeRepository.delete(notice.id);
    }
}
