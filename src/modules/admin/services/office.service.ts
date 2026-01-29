import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Office } from '../entities/office.entity';
import { CreateOfficeDto, UpdateOfficeDto } from '../dto/office.dto';

@Injectable()
export class OfficeService {
    constructor(
        @InjectRepository(Office)
        private readonly officeRepository: Repository<Office>,
    ) { }

    async create(createDto: CreateOfficeDto): Promise<Office> {
        const office = this.officeRepository.create(createDto);
        return await this.officeRepository.save(office);
    }

    async findAll(): Promise<Office[]> {
        return await this.officeRepository.find();
    }

    async findOne(id: number): Promise<Office> {
        const office = await this.officeRepository.findOne({ where: { officeId: id } });
        if (!office) {
            throw new NotFoundException(`Office with ID ${id} not found`);
        }
        return office;
    }

    async update(id: number, updateDto: UpdateOfficeDto): Promise<Office> {
        const office = await this.findOne(id);
        Object.assign(office, updateDto);
        return await this.officeRepository.save(office);
    }

    async remove(id: number): Promise<void> {
        const result = await this.officeRepository.delete(id);
        if (result.affected === 0) {
            throw new NotFoundException(`Office with ID ${id} not found`);
        }
    }
}
