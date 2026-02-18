import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
dotenv.config();

async function checkLoanTypes() {
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

        console.log('--- Loan Types in loan_pending ---');
        const types = await dataSource.query(`SELECT loantype, COUNT(*) FROM loan_pending GROUP BY loantype`);
        console.table(types);

        console.log('--- Columns in loan_pending_aln ---');
        const alnCols = await dataSource.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'loan_pending_aln'`);
        // console.table(alnCols);

        console.log('--- Columns in loan_pending_rln ---');
        const rlnCols = await dataSource.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'loan_pending_rln'`);
        // console.table(rlnCols);

        // Compare columns with loan_pending
        const lpCols = await dataSource.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'loan_pending'`);

        const alnMissing = lpCols.map(c => c.column_name).filter(c => !alnCols.find(ac => ac.column_name === c));
        const rlnMissing = lpCols.map(c => c.column_name).filter(c => !rlnCols.find(rc => rc.column_name === c));

        console.log('Missing columns in ALN (vs loan_pending):', alnMissing);
        console.log('Missing columns in RLN (vs loan_pending):', rlnMissing);

        await dataSource.destroy();
    } catch (error) {
        console.error('Check failed:', error);
    }
}
checkLoanTypes();
