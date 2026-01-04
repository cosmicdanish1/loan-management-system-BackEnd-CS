const { Client } = require('pg');

const headData = [
    { code: 'A1019', name: 'FFD BANK OF BARODA' },
    { code: 'A1021', name: 'STAFF CONSUMER LOAN' },
    { code: 'A1022', name: 'STAFF SECURITY DEPOSIT LOAN' },
    { code: 'A1045', name: 'ADVANCE TAX' },
    { code: 'A1023', name: 'AGM ADVANCE' },
    { code: 'E1018', name: 'AGM EXP' },
    { code: 'A1016', name: 'APEX BANK (F.R.S)' },
    { code: 'A1015', name: 'APEX BANK BHILAI' },
    { code: 'E1021', name: 'AUDIT FEE' },
    { code: 'L1025', name: 'AUDIT FEE PAYABLE' },
    { code: 'L1037', name: 'B.N.S.BANK RECOVERY' },
    { code: 'L1008', name: 'BAD DEBTS RESERVE' },
    { code: 'E1028', name: 'BANK COMMISSION AND BANK CHARGES' },
    { code: 'A1032', name: 'BUILDING A/C' },
    { code: 'L1007', name: 'BUILDING FUND' },
    { code: 'A1029', name: 'BUILDING MAINT. ADVANCE' },
    { code: 'E1024', name: 'BUILDING MAINT.EXP' },
    { code: 'L1020', name: 'BUILDING REPAIR' },
    { code: 'A1044', name: 'BUILDING REPAIR Smriti Housing Construction Committee BHILAI' },
    { code: 'A1043', name: 'BUILIDING REPAIR BHILAI SAH.BANK BHILAI' },
    { code: 'A1001', name: 'CASH IN HAND-31-10-2019' },
    { code: 'L1013', name: 'CELEBRATION FUND' },
    { code: 'E1017', name: 'CO-OP PROGRAMME' },
    { code: 'L1009', name: 'COMMAN BENEFIT FUND' },
    { code: 'L1004', name: 'COMPULSORY DEPOSIT' },
    { code: 'E1023', name: 'CONVEYANCE EXP' },
    { code: 'A1009', name: 'CURRENT ACCOUNT ANDHRA BANK SIVIK SECTOR BHIL Receipt' },
    { code: 'A1010', name: 'CURRENT ACCOUNT APEX BANK' },
    { code: 'A1008', name: 'CURRENT ACCOUNT PRAGTI MAHILA SAH.BANK SEC-2.BHIL4' },
    { code: 'A1012', name: 'CURRENT ACCOUNT STATE BANK OF INDIA NANDINI BRANCH' },
    { code: 'A1011', name: 'CURRENT ACCOUNT STATE BANK OF INDIA RAJHARA BRANCH' },
    { code: 'A1035', name: 'CYCLE STAND' },
    { code: 'L1017', name: 'CYCLE STAND FUND' },
    { code: 'E1029', name: 'DEPRECIATION' },
    { code: 'L1024', name: 'DIVIDEND PAID' },
    { code: 'E1007', name: 'E.D.L.I' },
    { code: 'L1040', name: 'E.K.C.C.S.RECOVERY' },
    { code: 'A1048', name: 'ELECTION ADVANCE' },
    { code: 'E1032', name: 'ELECTION EXP.' },
    { code: 'A1049', name: 'ELECTION RECEIPTS' },
    { code: 'A1047', name: 'EMERGENCY LOAN' },
    { code: 'L1027', name: 'EMPLOYEE BONUS/INTENSIVE PAYABLE' },
    { code: 'E1006', name: 'EMPLOYEE PROVIDENT FUND ADMINISTRATIVE EXP' },
    { code: 'L1011', name: 'EMPLOYEE WELFARE FUND' },
    { code: 'I1001', name: 'ENTRY FEE' },
    { code: 'E1004', name: 'EPF SOCIETY CONTRIBUTION' },
    { code: 'L1034', name: 'ESIC A/C' },
    { code: 'E1005', name: 'ESIC CONTRIBUTION' },
    { code: 'L1045', name: 'FAMILY RELIEF SCHEME FUND(FRS 2)' },
    { code: 'L1002', name: 'FAMILY RELIEF SEHCEME(FRS 1)' },
    { code: 'A1036', name: 'FURNITURE AND FIXTURES' },
    { code: 'L1028', name: 'G.S.L.I PAYABLE' },
    { code: 'L1030', name: 'G.S.L.I. ACCOUNT' },
    { code: 'E1008', name: 'GEN/MISC EXP' },
    { code: 'A1026', name: 'GENERAL ADVANCE' },
    { code: 'A1003', name: 'Government development Bond' },
    { code: 'L1012', name: 'GRAGUITY EQUILISATION FUND' },
    { code: 'L1026', name: 'GRAGUITY PAYABLE' },
    { code: 'E1003', name: 'GRATUITY' },
    { code: 'L1021', name: 'GROUND RENT AND SERVICE CHARGES' },
    { code: 'L1046', name: 'HEAD INSPECTION CHARGE EPFO' },
    { code: 'I1009', name: 'HOUSE RENT' },
    { code: 'L1041', name: 'INCOME TAX(TDS)' },
    { code: 'E1015', name: 'INSURANCE A/C (BUILD+CASH)' },
    { code: 'A1046', name: 'INTEREST DUE ON GOVT DEVLOP BONDS' },
    { code: 'E1027', name: 'INTEREST PAID ON SECURITY DEPOSIT' },
    { code: 'A1041', name: 'INTEREST RECEIVED ON STAFF HOUSING LOAN' },
    { code: 'I1007', name: 'INTT FORFIT A/C' },
    { code: 'I1003', name: 'INTT FROM M BANK' },
    { code: 'I1002', name: 'INTT FROM MEMBER' },
    { code: 'I1004', name: 'INTT FROM STAFF CONSUMER LOAN' },
    { code: 'I1006', name: 'INTT FROM STAFF HOUSE BUILDING LOAN' },
    { code: 'I1005', name: 'INTT FROM STAFF S.D. LOAN' },
    { code: 'E1026', name: 'INTT ON COMPULSORY DEPOSIT' },
    { code: 'I1010', name: 'INTT ON INCOME TAX REFUND' },
    { code: 'A1039', name: 'INTT RECEIVED FROM SMRITI GRIH NIRMAN SAMITI BHILAI' },
    { code: 'A1040', name: 'INTT RECOVERIABLE FROM CASH CERTIFICATE (FDR)' },
    { code: 'E1002', name: 'L.T.C' },
    { code: 'A1024', name: 'L.T.C. ADVANCE' },
    { code: 'A1033', name: 'LEASE PREMIUM A/C' },
    { code: 'A1027', name: 'LEGAL ADVANCE' },
    { code: 'E1013', name: 'LEGAL EXP' },
    { code: 'A1038', name: 'LOAN A/C OF SMRITI GRIH NIRMAN SAMITI MYDT BHILAI' },
    { code: 'A1034', name: 'MACHINARY A/C' },
    { code: 'L1003', name: 'MEMBER GROUP ACIDENTAL INSURANCE' },
    { code: 'L1042', name: 'MEMBERS INSURANCE CLAIM ACCOUNT' },
    { code: 'I1008', name: 'MISC RECEIPTS' },
    { code: 'L1018', name: 'MOTOR CYCLE FUND' },
    { code: 'E1025', name: 'NATIOLAL FESTIVAL & CULTURAL ACTIVITIES' },
    { code: 'E1030', name: 'NET PROFIT' },
    { code: 'L1043', name: 'NET PROFIT 2017-18' },
    { code: 'L1044', name: 'NET PROFIT F.Y.2018-2019' },
    { code: 'A1042', name: 'PLASTIC COVER' },
    { code: 'E1011', name: 'POSTAGE EXP' },
    { code: 'A1017', name: 'PRAGTI MAHILA SAH.BANK' },
    { code: 'A1018', name: 'PRAGTI MAHILA SAH.BANK (F.R.S)' },
    { code: 'E1010', name: 'PRINTING EXP' },
    { code: 'L1016', name: 'PROV FOR EXP TOWARDS SGNSS LOAN RECOVERY' },
    { code: 'L1014', name: 'PROV. FOR DOUBT LOAN S.G.N.S.S. MYDT' },
    { code: 'L1019', name: 'PROVISION FOR COMPUTER HARDWARE AND SOFTWAFE MAATNTANCE' },
    { code: 'E1016', name: 'PUBLICITY & PUB. RELATION' },
    { code: 'A1002', name: 'REGULAR LOAN' },
    { code: 'E1014', name: 'RENT & ELECT. EXP' },
    { code: 'A1025', name: 'RENT ADVANCE' },
    { code: 'L1006', name: 'RESERVE FUND' },
    { code: 'E1001', name: 'SALARY AND ALLOWANCES' },
    { code: 'A1005', name: 'SECURITY DEPOSIT BHILAI STEEL PLANT' },
    { code: 'L1001', name: 'SHARE VALUE' },
    { code: 'A1004', name: 'SHARE WITH CENTRAL CO-OP BANK' },
    { code: 'A1006', name: 'SHARE WITH DANT.M,S,S KARKHANA BALOUD' },
    { code: 'E1019', name: 'SITTING ALLOW' },
    { code: 'L1031', name: 'SSS (S) LIC INSURANCE PRIMIUM' },
    { code: 'L1033', name: 'STAFF EPF FUND' },
    { code: 'L1035', name: 'STAFF PENSION SCHEME' },
    { code: 'L1010', name: 'STAFF QUATERS' },
    { code: 'L1032', name: 'STAFF SECURITY FUND' },
    { code: 'L1036', name: 'STAFF UNION MEMBERSHIP FEE' },
    { code: 'A1030', name: 'STAFF WELFARE FUND ADVANCE' },
    { code: 'E1009', name: 'STATIONARY EXP' },
    { code: 'L1039', name: 'SUSPENCE ACCOUNT' },
    { code: 'E1012', name: 'TELEPHONE EXP' },
    { code: 'A1028', name: 'TOUR ADVANCE' },
    { code: 'E1031', name: 'UNIFORM EXP' },
    { code: 'E1022', name: 'UNION SUBSCRIPTION' },
    { code: 'L1023', name: 'UNION SUBSCRIPTION PAYABLE' },
    { code: 'L1015', name: 'V.R.S/RETIREMENT FUND' }
];

const client = new Client({
    user: 'postgres',
    host: 'localhost',
    database: 'EMP_Espat_Society',
    password: 'Test@1212',
    port: 5432,
});

async function updateHeadMaster() {
    try {
        await client.connect();
        console.log('Connected to database.');

        for (const item of headData) {
            // Check if exists
            const checkRes = await client.query('SELECT code FROM headmaster WHERE code = $1', [item.code]);

            if (checkRes.rows.length > 0) {
                // Update
                await client.query('UPDATE headmaster SET head_name = $1 WHERE code = $2', [item.name, item.code]);
                console.log(`Updated: ${item.code} -> ${item.name}`);
            } else {
                // Insert
                await client.query('INSERT INTO headmaster (code, head_name) VALUES ($1, $2)', [item.code, item.name]);
                console.log(`Inserted: ${item.code} -> ${item.name}`);
            }
        }

        console.log('All updates completed.');
    } catch (err) {
        console.error('Error executing updates:', err);
    } finally {
        await client.end();
    }
}

updateHeadMaster();
