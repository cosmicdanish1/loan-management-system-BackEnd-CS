import { ConflictException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Office } from '../entities/office.entity';
import { CreateOfficeDto, UpdateOfficeDto } from '../dto/office.dto';

@Injectable()
export class OfficeService {
    private readonly logger = new Logger(OfficeService.name);

    constructor(
        @InjectRepository(Office)
        private readonly officeRepository: Repository<Office>,
        private readonly dataSource: DataSource,
    ) { }

    async create(createDto: CreateOfficeDto): Promise<Office> {
        this.logger.log(`Creating office: ${JSON.stringify(createDto)}`);
        // save() on an existing primary key silently overwrites that office; creating must never do that (ES-299)
        if (await this.officeRepository.findOne({ where: { officeId: createDto.officeId } })) {
            throw new ConflictException(`Office ${createDto.officeId} already exists. Use update to change it.`);
        }
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
        // An office that members still belong to cannot be deleted. (ES-326)
        const used = await this.dataSource.query(`SELECT COUNT(*)::int AS n FROM member_master WHERE officeno = $1`, [id]);
        if (Number(used[0]?.n) > 0) {
            throw new ConflictException(`Office ${id} cannot be deleted: ${used[0].n} member(s) belong to it.`);
        }
        const result = await this.officeRepository.delete(id);
        if (result.affected === 0) {
            throw new NotFoundException(`Office with ID ${id} not found`);
        }
    }
}
