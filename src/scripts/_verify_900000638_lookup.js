const { Client } = require('pg');
const c = new Client({ host: 'localhost', port: 5432, database: 'EMP_Espat_Society', user: 'postgres', password: 'Test@1212' });
c.connect().then(async () => {
    const q = `SELECT m.mbno, TRIM(COALESCE(m.f_name,'')||' '||COALESCE(m.m_name,'')||' '||COALESCE(m.l_name,'')) AS name
               FROM member_master m
               WHERE (m.isactive='Y' OR m.isactive='1') AND m.mbno IS NOT NULL
                 AND (TRIM(COALESCE(m.f_name,'')||' '||COALESCE(m.m_name,'')||' '||COALESCE(m.l_name,'')) ILIKE $1 OR m.mbno::text ILIKE $1)`;
    const r1 = await c.query(q, ['%900000638%']);
    console.log('search "900000638":', r1.rows);
    const r2 = await c.query(q, ['%6100326%']);
    console.log('search "6100326" (as typed in the screenshot):', r2.rows);
    const r3 = await c.query(q, ['%638%']);
    console.log('search "638":', r3.rows);
    await c.end();
}).catch(e => { console.error(e.message); process.exit(1); });
