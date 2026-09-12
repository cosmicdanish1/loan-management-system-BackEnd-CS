import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Office } from '../entities/office.entity';
import { CreateOfficeDto, UpdateOfficeDto } from '../dto/office.dto';

@Injectable()
export class OfficeService {
    private readonly logger = new Logger(OfficeService.name);

    constructor(
        @InjectRepository(Office)
        private readonly officeRepository: Repository<Office>,
    ) { }

    async create(createDto: CreateOfficeDto): Promise<Office> {
        this.logger.log(`Creating office: ${JSON.stringify(createDto)}`);
        const office = this.officeRepository.create(createDto);
        return await this.officeRepository.save(office);
    }

    async findAll(): Promise<Office[]> {
        this.logger.log('Fetching all offices');
        return await this.officeRepository.find();
    }

    async findOne(id: number): Promise<Office> {
        this.logger.log(`Fetching office: ${id}`);
        const office = await this.officeRepository.findOne({ where: { officeId: id } });
        if (!office) {
            throw new NotFoundException(`Office with ID ${id} not found`);
        }
        return office;
    }

    async update(id: number, updateDto: UpdateOfficeDto): Promise<Office> {
        this.logger.log(`Updating office: ${id}`);
        const office = await this.findOne(id);
        Object.assign(office, updateDto);
        return await this.officeRepository.save(office);
    }

    async remove(id: number): Promise<void> {
        this.logger.log(`Removing office: ${id}`);
        const result = await this.officeRepository.delete(id);
        if (result.affected === 0) {
            throw new NotFoundException(`Office with ID ${id} not found`);
        }
    }
}
