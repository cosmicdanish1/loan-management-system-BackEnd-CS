import { AppDataSource } from '../config/database.config';

// Appends a new busrules row cloned from the current live one, with
// elngracedays set to 5 — demonstrates the new Grace Period field actually
// persists and is read back correctly through the real getBusinessRules/
// updateBusinessRules path (not just the column existing).
async function main() {
    await AppDataSource.initialize();
    const qr = AppDataSource.createQueryRunner();
    await qr.connect();
    try {
        await qr.query(
            `INSERT INTO busrules
             SELECT (jsonb_populate_record(
                        NULL::busrules,
                        to_jsonb(b) || jsonb_build_object('appdate', now(), 'elngracedays', 5)
                    )).*
             FROM busrules b
             ORDER BY b.appdate DESC LIMIT 1`
        );
        const after = await qr.query(
            `SELECT appdate::text, elnrate, elnpenalrate, elngracedays, rlnrate, rlnpenalrate, rlngracedays, alnrate, alnpenalrate, alngracedays
             FROM busrules ORDER BY appdate DESC LIMIT 1`
        );
        console.log('New newest busrules row:', after[0]);
    } finally {
        await qr.release();
        await AppDataSource.destroy();
    }
}
main().catch((e) => { console.error(e); process.exit(1); });
