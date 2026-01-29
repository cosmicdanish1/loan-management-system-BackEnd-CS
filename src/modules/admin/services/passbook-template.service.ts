import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { PassbookTemplate, PassbookField, PassbookPagePosition } from '../entities';
import { CreatePassbookTemplateDto, UpdatePassbookTemplateDto } from '../dto';

@Injectable()
export class PassbookTemplateService {
    constructor(
        @InjectRepository(PassbookTemplate)
        private readonly templateRepository: Repository<PassbookTemplate>,
        private readonly dataSource: DataSource,
    ) { }

    async findAll(): Promise<PassbookTemplate[]> {
        return this.templateRepository.find({
            relations: ['fields', 'pageSettings'],
            order: { templateName: 'ASC' },
        });
    }

    async findOne(id: number): Promise<PassbookTemplate> {
        const template = await this.templateRepository.findOne({
            where: { id },
            relations: ['fields', 'pageSettings'],
        });

        if (!template) {
            throw new NotFoundException(`Passbook template with ID ${id} not found`);
        }

        return template;
    }

    async findDefaultByAccountType(accountType: string): Promise<PassbookTemplate> {
        const template = await this.templateRepository.findOne({
            where: { accountType, isDefault: true },
            relations: ['fields', 'pageSettings'],
        });

        if (!template) {
            const fallback = await this.templateRepository.findOne({
                where: { accountType },
                relations: ['fields', 'pageSettings'],
                order: { createdAt: 'ASC' },
            });

            if (!fallback) {
                throw new NotFoundException(`No passbook templates found for account type ${accountType}`);
            }
            return fallback;
        }

        return template;
    }

    async create(dto: CreatePassbookTemplateDto): Promise<PassbookTemplate> {
        return this.dataSource.transaction(async (manager) => {
            if (dto.isDefault) {
                await manager.update(PassbookTemplate,
                    { accountType: dto.accountType, isDefault: true },
                    { isDefault: false }
                );
            }

            const template = manager.create(PassbookTemplate, {
                templateName: dto.templateName,
                accountType: dto.accountType,
                isDefault: dto.isDefault,
            });

            const savedTemplate = await manager.save(template);

            // Save page settings
            const pageSettings = manager.create(PassbookPagePosition, {
                ...dto.pageSettings,
                templateId: savedTemplate.id
            });
            await manager.save(pageSettings);

            // Save fields
            const fields = dto.fields.map(f => manager.create(PassbookField, {
                ...f,
                templateId: savedTemplate.id
            }));
            await manager.save(fields);

            return this.findOne(savedTemplate.id);
        });
    }

    async update(id: number, dto: UpdatePassbookTemplateDto): Promise<PassbookTemplate> {
        return this.dataSource.transaction(async (manager) => {
            const existing = await this.findOne(id);

            if (dto.isDefault && !existing.isDefault) {
                await manager.update(PassbookTemplate,
                    { accountType: dto.accountType, isDefault: true },
                    { isDefault: false }
                );
            }

            await manager.update(PassbookTemplate, id, {
                templateName: dto.templateName,
                accountType: dto.accountType,
                isDefault: dto.isDefault,
            });

            // Update page settings
            await manager.delete(PassbookPagePosition, { templateId: id });
            const pageSettings = manager.create(PassbookPagePosition, {
                ...dto.pageSettings,
                templateId: id
            });
            await manager.save(pageSettings);

            // Update fields (delete and re-add)
            await manager.delete(PassbookField, { templateId: id });
            const newFields = dto.fields.map(f => manager.create(PassbookField, {
                ...f,
                id: undefined,
                templateId: id
            }));
            await manager.save(newFields);

            return this.findOne(id);
        });
    }

    async remove(id: number): Promise<void> {
        const result = await this.templateRepository.delete(id);
        if (result.affected === 0) {
            throw new NotFoundException(`Passbook template with ID ${id} not found`);
        }
    }
}
