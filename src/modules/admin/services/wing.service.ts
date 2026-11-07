import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Wing } from '../entities/wing.entity';
import { CreateWingDto, UpdateWingDto } from '../dto/wing.dto';

@Injectable()
export class WingService {
    constructor(
        @InjectRepository(Wing)
        private readonly wingRepository: Repository<Wing>,
        private readonly dataSource: DataSource,
    ) { }

    async create(createDto: CreateWingDto): Promise<Wing> {
        // save() on an existing primary key silently overwrites that wing; creating must never do that (ES-299)
        if (await this.wingRepository.findOne({ where: { wingId: createDto.wingId } })) {
            throw new ConflictException(`Wing ${createDto.wingId} already exists. Use update to change it.`);
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
        // A wing that members still belong to cannot be deleted. (ES-326)
        const used = await this.dataSource.query(`SELECT COUNT(*)::int AS n FROM member_master WHERE wingno::text = $1`, [String(id)]);
        if (Number(used[0]?.n) > 0) {
            throw new ConflictException(`Wing ${id} cannot be deleted: ${used[0].n} member(s) belong to it.`);
        }
        const result = await this.wingRepository.delete(id);
        if (result.affected === 0) {
            throw new NotFoundException(`Wing with ID ${id} not found`);
        }
    }
}
