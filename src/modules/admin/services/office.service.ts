import { ConflictException, Injectable, NotFoundException, Logger } from '@nestjs/common';
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
        // BUG FIX: officeId is the PK — repository.save() on an entity whose PK
        // already exists silently UPDATEs instead of erroring, same gap as
        // WingService.create() and SB Account creation.
        const existing = await this.officeRepository.findOne({ where: { officeId: createDto.officeId } });
        if (existing) {
            throw new ConflictException(`Office ${createDto.officeId} already exists`);
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
        // Guard: members are assigned to an office by number in member_master.officeno.
        // Deleting an office still in use would orphan those members, so block it —
        // same pattern as CastCategoryService.remove().
        await this.findOne(id); // throws NotFound if missing
        const inUse = await this.officeRepository.query(
            `SELECT COUNT(*)::int AS count FROM member_master WHERE officeno = $1`,
            [id]
        );
        const count = inUse?.[0]?.count ?? 0;
        if (count > 0) {
            throw new ConflictException(
                `Cannot delete office ${id} — ${count} member(s) are assigned to this office. Reassign them first.`
            );
        }

        const result = await this.officeRepository.delete(id);
        if (result.affected === 0) {
            throw new NotFoundException(`Office with ID ${id} not found`);
        }
    }
}
