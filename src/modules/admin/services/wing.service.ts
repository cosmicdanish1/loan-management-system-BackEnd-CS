import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Wing } from '../entities/wing.entity';
import { CreateWingDto, UpdateWingDto } from '../dto/wing.dto';

@Injectable()
export class WingService {
    constructor(
        @InjectRepository(Wing)
        private readonly wingRepository: Repository<Wing>,
    ) { }

    async create(createDto: CreateWingDto): Promise<Wing> {
        // BUG FIX: wingId is the PK — repository.save() on an entity whose PK
        // already exists silently UPDATEs instead of erroring. Confirmed live:
        // POST-ing an existing wingId with a different name returned 201 and
        // clobbered the real row with no warning. Same class of gap already
        // fixed for SB Account creation.
        const existing = await this.wingRepository.findOne({ where: { wingId: createDto.wingId } });
        if (existing) {
            throw new ConflictException(`Wing ${createDto.wingId} already exists`);
        }
        const wing = this.wingRepository.create(createDto);
        return await this.wingRepository.save(wing);
    }

    async findAll(): Promise<Wing[]> {
        return await this.wingRepository.find();
    }

    async findOne(id: string): Promise<Wing> {
        const wing = await this.wingRepository.findOne({ where: { wingId: id } });
        if (!wing) {
            throw new NotFoundException(`Wing with ID ${id} not found`);
        }
        return wing;
    }

    async update(id: string, updateDto: UpdateWingDto): Promise<Wing> {
        const wing = await this.findOne(id);
        Object.assign(wing, updateDto);
        return await this.wingRepository.save(wing);
    }

    async remove(id: string): Promise<void> {
        // Guard: members are assigned to a wing by code in member_master.wingno.
        // Deleting a wing still in use would orphan those members, so block it —
        // same pattern as CastCategoryService.remove().
        await this.findOne(id); // throws NotFound if missing
        const inUse = await this.wingRepository.query(
            `SELECT COUNT(*)::int AS count FROM member_master WHERE wingno = $1`,
            [id]
        );
        const count = inUse?.[0]?.count ?? 0;
        if (count > 0) {
            throw new ConflictException(
                `Cannot delete wing ${id} — ${count} member(s) are assigned to this wing. Reassign them first.`
            );
        }

        const result = await this.wingRepository.delete(id);
        if (result.affected === 0) {
            throw new NotFoundException(`Wing with ID ${id} not found`);
        }
    }
}
