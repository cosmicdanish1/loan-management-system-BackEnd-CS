import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CastCategory } from '../entities/cast-category.entity';
import { CreateCastCategoryDto, UpdateCastCategoryDto } from '../dto/cast-category.dto';

@Injectable()
export class CastCategoryService {
    private readonly logger = new Logger(CastCategoryService.name);

    constructor(
        @InjectRepository(CastCategory)
        private castCategoryRepository: Repository<CastCategory>,
    ) { }

    async create(createCastCategoryDto: CreateCastCategoryDto): Promise<CastCategory> {
        // BUG FIX: id is the PK — repository.save() on an entity whose PK
        // already exists silently UPDATEs instead of erroring. Confirmed live:
        // POST-ing an existing id with a different name returned 201 and
        // clobbered the real row with no warning. Same class of gap already
        // fixed for Wing/Office/SB Account creation.
        const existing = await this.castCategoryRepository.findOne({ where: { id: createCastCategoryDto.id } });
        if (existing) {
            throw new ConflictException(`Cast Category ${createCastCategoryDto.id} already exists`);
        }
        // Members are linked to a category by NAME (see update/remove below), so two
        // rows sharing a name — even under different ids — would make that link
        // ambiguous. Case/whitespace-insensitive to match the rename/delete matching.
        const duplicateName = await this.findByNameCI(createCastCategoryDto.name);
        if (duplicateName) {
            throw new ConflictException(`A category named "${createCastCategoryDto.name}" already exists (ID ${duplicateName.id})`);
        }
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
        const oldName = castCategory.name;

        if (updateCastCategoryDto.name) {
            const duplicateName = await this.findByNameCI(updateCastCategoryDto.name);
            if (duplicateName && duplicateName.id !== id) {
                throw new ConflictException(`A category named "${updateCastCategoryDto.name}" already exists (ID ${duplicateName.id})`);
            }
        }

        Object.assign(castCategory, updateCastCategoryDto);
        const saved = await this.castCategoryRepository.save(castCategory);

        // Members store their category by NAME — cascade a rename so assigned members stay consistent.
        if (saved.name && oldName && saved.name !== oldName) {
            const updated = await this.castCategoryRepository.query(
                `UPDATE member_master SET cast_category = $1
                 WHERE LOWER(TRIM(cast_category)) = LOWER(TRIM($2))
                 RETURNING mbno`,
                [saved.name, oldName]
            );
            const affected = Array.isArray(updated) ? updated.length : 0;
            if (affected) {
                this.logger.log(`Renamed "${oldName}" → "${saved.name}", updated ${affected} member(s)`);
            }
        }
        return saved;
    }

    async remove(id: number): Promise<void> {
        // Guard: members store their category by NAME in member_master.cast_category.
        // Deleting a category that's in use would orphan those members, so block it.
        const category = await this.findOne(id); // throws NotFound if missing
        const inUse = await this.castCategoryRepository.query(
            `SELECT COUNT(*)::int AS count FROM member_master
             WHERE LOWER(TRIM(cast_category)) = LOWER(TRIM($1))`,
            [category.name]
        );
        const count = inUse?.[0]?.count ?? 0;
        if (count > 0) {
            throw new ConflictException(
                `Cannot delete "${category.name}" — ${count} member(s) are assigned to this category. Reassign them first.`
            );
        }

        const result = await this.castCategoryRepository.delete(id);
        if (result.affected === 0) {
            throw new NotFoundException(`Cast Category with ID ${id} not found`);
        }
    }

    private async findByNameCI(name: string): Promise<CastCategory | undefined> {
        const rows = await this.castCategoryRepository.query(
            `SELECT id, castcategory AS name FROM castcategorymaster WHERE LOWER(TRIM(castcategory)) = LOWER(TRIM($1)) LIMIT 1`,
            [name]
        );
        return rows?.[0];
    }
}
