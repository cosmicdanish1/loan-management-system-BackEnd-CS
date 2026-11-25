import { BadRequestException, ConflictException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Office } from '../entities/office.entity';
import { CreateOfficeDto, UpdateOfficeDto } from '../dto/office.dto';

/** An office / branch of the society. Stored in DIVISION_MASTER, as the legacy does. */
@Injectable()
export class OfficeService {
    private readonly logger = new Logger(OfficeService.name);

    constructor(
        @InjectRepository(Office)
        private readonly officeRepository: Repository<Office>,
        private readonly dataSource: DataSource,
    ) { }

    /** The wing must exist (Division / RO is a choice of the wings). */
    private async assertWingExists(runner: { query: (sql: string, p?: any[]) => Promise<any> }, wingId: string): Promise<void> {
        const rows = await runner.query(`SELECT 1 FROM wingmast WHERE wingno = $1 LIMIT 1`, [wingId]);
        if (!rows || rows.length === 0) {
            throw new BadRequestException(`Division / RO "${wingId}" does not exist. Create the wing first (Wing tab).`);
        }
    }

    /**
     * New office. "For the new branch, Branch No should be left blank": the server gives the next number (highest + 1)
     * under a lock, so two people saving at the same moment never get the same number. A typed number that is already
     * an office is refused (save() on an existing key used to overwrite it, ES-299).
     */
    async create(createDto: CreateOfficeDto): Promise<Office> {
        this.logger.log(`Creating office: ${JSON.stringify(createDto)}`);
        const name = String(createDto.officeName ?? '').trim();
        if (!name) throw new BadRequestException('Office name is required.');
        const wingId = String(createDto.wingId ?? '').trim();
        if (!wingId) throw new BadRequestException('Division / RO (wing) is required.');

        const runner = this.dataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        try {
            await this.assertWingExists(runner, wingId);
            await runner.query(`SELECT pg_advisory_xact_lock(hashtext('office_master_no'))`);
            let officeId = createDto.officeId;
            if (officeId === undefined || officeId === null) {
                const r = await runner.query(`SELECT COALESCE(MAX(officeno), 0)::int + 1 AS next FROM division_master`);
                officeId = Number(r[0].next);
            } else {
                const exists = await runner.query(`SELECT 1 FROM division_master WHERE officeno = $1 LIMIT 1`, [officeId]);
                if (exists.length > 0) {
                    throw new ConflictException(`Office ${officeId} already exists. Use update to change it.`);
                }
            }
            const row = {
                officeId, wingId, officeName: name,
                division: createDto.division ?? officeId,
                address: (createDto.address ?? '').trim(),
                city: (createDto.city ?? '').trim(),
            };
            await runner.query(
                `INSERT INTO division_master (wingno, officeno, divno, name, address, city) VALUES ($1, $2, $3, $4, $5, $6)`,
                [row.wingId, row.officeId, row.division, row.officeName, row.address, row.city],
            );
            await runner.commitTransaction();
            return row as Office;
        } catch (e) {
            await runner.rollbackTransaction();
            throw e;
        } finally {
            await runner.release();
        }
    }

    async findAll(): Promise<Office[]> {
        this.logger.log('Fetching all offices');
        return await this.officeRepository.find({ order: { officeId: 'ASC' } });
    }

    async findOne(id: number): Promise<Office> {
        this.logger.log(`Fetching office: ${id}`);
        const office = await this.officeRepository.findOne({ where: { officeId: id } });
        if (!office) {
            throw new NotFoundException(`Office with ID ${id} not found`);
        }
        return office;
    }

    /**
     * Change an office. When the office moves to another wing, the members of that office follow it, as the legacy
     * trigger Trg_UpdateWingDivisionMaster does: every member of the office that is not retired (FLG_RETIRE = 'N'; a member with no flag counts as not retired)
     * gets the new wing. Both changes are saved together. The answer carries `membersMoved`.
     */
    async update(id: number, updateDto: UpdateOfficeDto): Promise<Office & { membersMoved: number }> {
        this.logger.log(`Updating office: ${id}`);
        const runner = this.dataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        try {
            const rows = await runner.query(`SELECT wingno, divno, name, address, city FROM division_master WHERE officeno = $1 FOR UPDATE`, [id]);
            if (!rows || rows.length === 0) throw new NotFoundException(`Office with ID ${id} not found`);
            const cur = rows[0];
            const name = updateDto.officeName !== undefined ? String(updateDto.officeName).trim() : cur.name;
            if (!name) throw new BadRequestException('Office name is required.');
            const wingId = updateDto.wingId !== undefined ? String(updateDto.wingId).trim() : String(cur.wingno).trim();
            if (!wingId) throw new BadRequestException('Division / RO (wing) is required.');
            const wingChanged = wingId !== String(cur.wingno).trim();
            if (wingChanged) await this.assertWingExists(runner, wingId);
            const next = {
                officeId: id, wingId, officeName: name,
                division: updateDto.division !== undefined ? updateDto.division : Number(cur.divno),
                address: updateDto.address !== undefined ? String(updateDto.address).trim() : cur.address,
                city: updateDto.city !== undefined ? String(updateDto.city).trim() : cur.city,
            };
            await runner.query(
                `UPDATE division_master SET wingno = $2, divno = $3, name = $4, address = $5, city = $6 WHERE officeno = $1`,
                [id, next.wingId, next.division, next.officeName, next.address, next.city],
            );
            let membersMoved = 0;
            if (wingChanged) {
                const moved = await runner.query(
                    `UPDATE member_master SET wingno = $2 WHERE officeno = $1 AND COALESCE(flg_retire, 'N') <> 'Y' RETURNING mbno`,
                    [id, next.wingId],
                );
                const movedRows: any[] = Array.isArray(moved?.[0]) ? moved[0] : moved;
                membersMoved = movedRows.length;
            }
            await runner.commitTransaction();
            return { ...(next as Office), membersMoved };
        } catch (e) {
            await runner.rollbackTransaction();
            throw e;
        } finally {
            await runner.release();
        }
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
