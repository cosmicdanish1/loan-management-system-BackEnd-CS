import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Designation } from '../entities/designation.entity';
import { CreateDesignationDto, UpdateDesignationDto } from '../dto/designation.dto';

@Injectable()
export class DesignationService {
    constructor(
        @InjectRepository(Designation)
        private designationRepository: Repository<Designation>,
    ) { }

    async create(createDesignationDto: CreateDesignationDto): Promise<Designation> {
        // BUG FIX: code is the PK — repository.save() on an entity whose PK
        // already exists silently UPDATEs instead of erroring. Same class of
        // gap already fixed for Wing/Office/CastCategory/SB Account creation.
        const existing = await this.designationRepository.findOne({ where: { code: createDesignationDto.code } });
        if (existing) {
            throw new ConflictException(`Designation ${createDesignationDto.code} already exists`);
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
        const result = await this.designationRepository.delete(code);
        if (result.affected === 0) {
            throw new NotFoundException(`Designation with code ${code} not found`);
        }
    }
}
