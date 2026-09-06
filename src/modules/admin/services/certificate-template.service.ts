import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CertificateTemplate, CertificateField } from '../entities';
import { CreateCertificateTemplateDto, UpdateCertificateTemplateDto } from '../dto';

@Injectable()
export class CertificateTemplateService {
    constructor(
        @InjectRepository(CertificateTemplate)
        private readonly templateRepository: Repository<CertificateTemplate>,
        @InjectRepository(CertificateField)
        private readonly fieldRepository: Repository<CertificateField>,
        private readonly dataSource: DataSource,
    ) { }

    async findAll(): Promise<CertificateTemplate[]> {
        return this.templateRepository.find({
            relations: ['fields'],
            order: { templateName: 'ASC' },
        });
    }

    async findOne(id: number): Promise<CertificateTemplate> {
        const template = await this.templateRepository.findOne({
            where: { id },
            relations: ['fields'],
        });

        if (!template) {
            throw new NotFoundException(`Certificate template with ID ${id} not found`);
        }

        return template;
    }

    async findByName(name: string): Promise<CertificateTemplate> {
        const template = await this.templateRepository.findOne({
            where: { templateName: name },
            relations: ['fields'],
        });

        if (!template) {
            throw new NotFoundException(`Certificate template with name ${name} not found`);
        }

        return template;
    }

    async findDefaultByAccountType(accountType: string): Promise<CertificateTemplate> {
        const template = await this.templateRepository.findOne({
            where: { accountType, isDefault: true },
            relations: ['fields'],
        });

        if (!template) {
            // Fallback to the first one available for this type if no default is marked
            const fallback = await this.templateRepository.findOne({
                where: { accountType },
                relations: ['fields'],
                order: { createdAt: 'ASC' },
            });

            if (!fallback) {
                throw new NotFoundException(`No certificate templates found for account type ${accountType}`);
            }
            return fallback;
        }

        return template;
    }

    async create(dto: CreateCertificateTemplateDto): Promise<CertificateTemplate> {
        return this.dataSource.transaction(async (manager) => {
            // If marked as default, unset other defaults for same account type
            if (dto.isDefault) {
                await manager.update(CertificateTemplate,
                    { accountType: dto.accountType, isDefault: true },
                    { isDefault: false }
                );
            }

            const template = manager.create(CertificateTemplate, {
                templateName: dto.templateName,
                accountType: dto.accountType,
                isDefault: dto.isDefault,
            });

            const savedTemplate = await manager.save(template);

            const fields = dto.fields.map(f => manager.create(CertificateField, {
                ...f,
                templateId: savedTemplate.id
            }));

            await manager.save(fields);

            // 5.3 fix: this.findOne() uses a fresh repository connection that
            // can't see this transaction's uncommitted insert — confirmed live,
            // every create() 404'd on its own just-created row. Read back
            // through the transactional manager instead.
            const created = await manager.findOne(CertificateTemplate, {
                where: { id: savedTemplate.id },
                relations: ['fields'],
            });
            if (!created) {
                throw new NotFoundException(`Certificate template with ID ${savedTemplate.id} not found`);
            }
            return created;
        });
    }

    async update(id: number, dto: UpdateCertificateTemplateDto): Promise<CertificateTemplate> {
        return this.dataSource.transaction(async (manager) => {
            const existing = await this.findOne(id);

            // If marked as default, unset other defaults for same account type
            if (dto.isDefault && !existing.isDefault) {
                await manager.update(CertificateTemplate,
                    { accountType: dto.accountType, isDefault: true },
                    { isDefault: false }
                );
            }

            // Update basic info
            await manager.update(CertificateTemplate, id, {
                templateName: dto.templateName,
                accountType: dto.accountType,
                isDefault: dto.isDefault,
            });

            // Simple strategy for fields: Remove all and re-add 
            // (Better for mapping dynamic UI grids where keys might change order)
            await manager.delete(CertificateField, { templateId: id });

            const newFields = dto.fields.map(f => manager.create(CertificateField, {
                ...f,
                id: undefined, // Don't use old IDs
                templateId: id
            }));

            await manager.save(newFields);

            // 5.3 fix: same wrong-connection read-after-write bug as create().
            const updated = await manager.findOne(CertificateTemplate, {
                where: { id },
                relations: ['fields'],
            });
            if (!updated) {
                throw new NotFoundException(`Certificate template with ID ${id} not found`);
            }
            return updated;
        });
    }

    async remove(id: number): Promise<void> {
        const result = await this.templateRepository.delete(id);
        if (result.affected === 0) {
            throw new NotFoundException(`Certificate template with ID ${id} not found`);
        }
    }
}
