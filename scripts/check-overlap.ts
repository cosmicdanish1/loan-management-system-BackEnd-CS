import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
dotenv.config();

async function checkOverlap() {
    const dataSource = new DataSource({
        type: 'postgres',
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        username: process.env.DB_USERNAME || 'postgres',
        password: process.env.DB_PASSWORD || 'admin',
        database: process.env.DB_DATABASE || 'EMP_Espat_Society',
    });

    try {
        await dataSource.initialize();
        const lpSanctioned = await dataSource.query(`SELECT loancaseNo FROM loan_pending WHERE flg_sanctioned = 'Y' AND flg_paid = 'N'`);
        const sanctionedCases = lpSanctioned.map(l => l.loancaseno);

        console.log('Sanctioned Cases in loan_pending:', sanctionedCases);

        for (const caseNo of sanctionedCases) {
            const inAln = await dataSource.query(`SELECT 1 FROM loan_pending_aln WHERE loancaseNo = $1`, [caseNo]);
            const inRln = await dataSource.query(`SELECT 1 FROM loan_pending_rln WHERE loancaseNo = $1`, [caseNo]);
            console.log(`Case ${caseNo}: In Aln? ${inAln.length > 0}, In Rln? ${inRln.length > 0}`);
        }

        await dataSource.destroy();
    } catch (error) {
        console.error('Check failed:', error);
    }
}
checkOverlap();
