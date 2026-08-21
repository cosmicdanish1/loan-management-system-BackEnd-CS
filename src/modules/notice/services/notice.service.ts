import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DashboardNotice } from '../entities/dashboard-notice.entity';

@Injectable()
export class NoticeService {
    constructor(
        @InjectRepository(DashboardNotice)
        private readonly noticeRepository: Repository<DashboardNotice>,
    ) { }

    async findAll(): Promise<DashboardNotice[]> {
        return this.noticeRepository.find({
            order: { sortOrder: 'ASC', createdAt: 'DESC' },
        });
    }

    async create(data: {
        title: string;
        message: string;
        type: DashboardNotice['type'];
        postedBy: string;
    }): Promise<DashboardNotice> {
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
        return this.noticeRepository.save(notice);
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

    async remove(id: number): Promise<void> {
        const result = await this.noticeRepository.delete(id);
        if (!result.affected) {
            throw new NotFoundException(`Notice ${id} not found`);
        }
    }
}
