import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CastCategory } from '../entities/cast-category.entity';
import { CreateCastCategoryDto, UpdateCastCategoryDto } from '../dto/cast-category.dto';

@Injectable()
export class CastCategoryService {
    constructor(
        @InjectRepository(CastCategory)
        private castCategoryRepository: Repository<CastCategory>,
    ) { }

    async create(createCastCategoryDto: CreateCastCategoryDto): Promise<CastCategory> {
        const castCategory = this.castCategoryRepository.create(createCastCategoryDto);
        return this.castCategoryRepository.save(castCategory);
    }

    async findAll(): Promise<CastCategory[]> {
        return this.castCategoryRepository.find({
            order: {
                id: 'ASC',
            },
        });
    }

    async findOne(id: number): Promise<CastCategory> {
        const castCategory = await this.castCategoryRepository.findOne({ where: { id } });
        if (!castCategory) {
            throw new NotFoundException(`Cast Category with ID ${id} not found`);
        }
        return castCategory;
    }

    async update(id: number, updateCastCategoryDto: UpdateCastCategoryDto): Promise<CastCategory> {
        const castCategory = await this.findOne(id);
        Object.assign(castCategory, updateCastCategoryDto);
        return this.castCategoryRepository.save(castCategory);
    }

    async remove(id: number): Promise<void> {
        const result = await this.castCategoryRepository.delete(id);
        if (result.affected === 0) {
            throw new NotFoundException(`Cast Category with ID ${id} not found`);
        }
    }
}
