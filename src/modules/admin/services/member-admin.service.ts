import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

// BUG FIX: this service used to read/write the TypeORM `BankMember` entity
// (table `bankmas`) — confirmed live that table has 0 rows. Every real member
// lives in `member_master`, keyed by `mbno`, with office assignment in
// `officeno` (the same table every other admin service in this codebase
// already uses). Rewritten to operate on the real table directly.
@Injectable()
export class MemberAdminService {
    constructor(private readonly dataSource: DataSource) { }

    async findOne(memberNo: number): Promise<any> {
        const rows = await this.dataSource.query(
            `SELECT mbno as "memberNo", officeno as "officeId",
                    TRIM(COALESCE(f_name, '') || ' ' || COALESCE(m_name, '') || ' ' || COALESCE(l_name, '')) as "memberName"
             FROM member_master WHERE mbno = $1`,
            [memberNo],
        );
        if (!rows || rows.length === 0) {
            throw new NotFoundException(`Member with ID ${memberNo} not found`);
        }
        return rows[0];
    }

    async updateOffice(memberNo: number, newOfficeId: string): Promise<any> {
        await this.findOne(memberNo); // throws NotFound if the member doesn't exist

        const officeIdNum = parseInt(newOfficeId, 10);
        if (isNaN(officeIdNum)) {
            throw new BadRequestException(`Invalid office id: ${newOfficeId}`);
        }
        const officeExists = await this.dataSource.query(
            `SELECT 1 FROM office_master WHERE officeno = $1`,
            [officeIdNum],
        );
        if (!officeExists || officeExists.length === 0) {
            throw new NotFoundException(`Office ${newOfficeId} does not exist`);
        }

        await this.dataSource.query(
            `UPDATE member_master SET officeno = $1 WHERE mbno = $2`,
            [officeIdNum, memberNo],
        );
        return this.findOne(memberNo);
    }
}
