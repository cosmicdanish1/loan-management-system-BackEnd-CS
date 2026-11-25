import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Wing } from '../entities/wing.entity';
import { CreateWingDto, UpdateWingDto, WING_STATE_MESSAGE } from '../dto/wing.dto';

/** A wing (Division / RO) of the society. Stored in WINGMAST, as the legacy does. */
@Injectable()
export class WingService {
    constructor(
        @InjectRepository(Wing)
        private readonly wingRepository: Repository<Wing>,
        private readonly dataSource: DataSource,
    ) { }

    /** 1 = In State, 0 = Out State; anything else is "Invalid State" (the legacy message). A missing state means In State. */
    static parseState(state: unknown): number {
        if (state === undefined || state === null || String(state).trim() === '') return 1;
        const s = String(state).trim();
        if (s !== '0' && s !== '1') throw new BadRequestException(WING_STATE_MESSAGE);
        return Number(s);
    }

    async create(createDto: CreateWingDto): Promise<Wing> {
        const code = String(createDto.wingId ?? '').trim();
        if (!code) throw new BadRequestException('Wing code is required.');
        // save() on an existing primary key silently overwrites that wing; creating must never do that (ES-299)
        if (await this.wingRepository.findOne({ where: { wingId: code } })) {
            throw new ConflictException(`Wing ${code} already exists. Use update to change it.`);
        }
        const state = WingService.parseState(createDto.state);
        const wing = this.wingRepository.create({ wingId: code, wingName: (createDto.wingName ?? '').trim(), state });
        return await this.wingRepository.save(wing);
    }

    async findAll(): Promise<Wing[]> {
        return await this.wingRepository.find({ order: { wingId: 'ASC' } });
    }

    async findOne(id: string): Promise<Wing> {
        const wing = await this.wingRepository.findOne({ where: { wingId: String(id).trim() } });
        if (!wing) {
            throw new NotFoundException(`Wing with ID ${id} not found`);
        }
        return wing;
    }

    async update(id: string, updateDto: UpdateWingDto): Promise<Wing> {
        const wing = await this.findOne(id);
        // ES-306: the wing is the one named by the URL. A wingId in the body is not a way to rename its key (save() would
        // have written a second wing under the new code), so it is left out.
        if (updateDto.wingName !== undefined) wing.wingName = String(updateDto.wingName).trim();
        if (updateDto.state !== undefined) wing.state = WingService.parseState(updateDto.state);
        return await this.wingRepository.save(wing);
    }

    async remove(id: string): Promise<void> {
        const code = String(id).trim();
        // A wing that members or offices still belong to cannot be deleted. (ES-326)
        const used = await this.dataSource.query(`SELECT COUNT(*)::int AS n FROM member_master WHERE wingno::text = $1`, [code]);
        if (Number(used[0]?.n) > 0) {
            throw new ConflictException(`Wing ${code} cannot be deleted: ${used[0].n} member(s) belong to it.`);
        }
        const offices = await this.dataSource.query(`SELECT COUNT(*)::int AS n FROM division_master WHERE wingno = $1`, [code]);
        if (Number(offices[0]?.n) > 0) {
            throw new ConflictException(`Wing ${code} cannot be deleted: ${offices[0].n} office(s) belong to it.`);
        }
        const result = await this.wingRepository.delete(code);
        if (result.affected === 0) {
            throw new NotFoundException(`Wing with ID ${id} not found`);
        }
    }
}
