import { Injectable, NotFoundException } from '@nestjs/common';
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
        const result = await this.wingRepository.delete(id);
        if (result.affected === 0) {
            throw new NotFoundException(`Wing with ID ${id} not found`);
        }
    }
}
