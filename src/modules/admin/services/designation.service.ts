import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Designation } from '../entities/designation.entity';
import { CreateDesignationDto, UpdateDesignationDto } from '../dto/designation.dto';

@Injectable()
export class DesignationService {
    constructor(
        @InjectRepository(Designation)
        private designationRepository: Repository<Designation>,
        private readonly dataSource: DataSource,
    ) { }

    async create(createDesignationDto: CreateDesignationDto): Promise<Designation> {
        // save() on an existing primary key silently overwrites that designation; creating must never do that (ES-299)
        if (await this.designationRepository.findOne({ where: { code: createDesignationDto.code } })) {
            throw new ConflictException(`Designation ${createDesignationDto.code} already exists. Use update to change it.`);
        }
        const designation = this.designationRepository.create(createDesignationDto);
        return this.designationRepository.save(designation);
    }

    async findAll(): Promise<Designation[]> {
        return this.designationRepository.find({
            order: {
                code: 'ASC',
            },
        });
    }

    async findOne(code: string): Promise<Designation> {
        const designation = await this.designationRepository.findOne({ where: { code } });
        if (!designation) {
            throw new NotFoundException(`Designation with code ${code} not found`);
        }
        return designation;
    }

    async update(code: string, updateDesignationDto: UpdateDesignationDto): Promise<Designation> {
        const designation = await this.findOne(code);
        Object.assign(designation, updateDesignationDto);
        return this.designationRepository.save(designation);
    }

    async remove(code: string): Promise<void> {
        // A designation that members still hold cannot be deleted (same rule as offices and wings, ES-326)
        const used = await this.dataSource.query(`SELECT COUNT(*)::int AS n FROM member_master WHERE desig = $1`, [code]);
        if (Number(used[0]?.n) > 0) {
            throw new ConflictException(`Designation ${code} cannot be deleted: ${used[0].n} member(s) hold it.`);
        }
        const result = await this.designationRepository.delete(code);
        if (result.affected === 0) {
            throw new NotFoundException(`Designation with code ${code} not found`);
        }
    }
}
