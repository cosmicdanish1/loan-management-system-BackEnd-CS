const { Client } = require('pg');
(async () => {
  const client = new Client({ host: 'localhost', port: 5432, user: 'postgres', password: 'Test@1212', database: 'EMP_Espat_Society' });
  await client.connect();
  console.log('after pass:', (await client.query(`SELECT mbno, regularloan FROM member_balances WHERE mbno = '900000002'`)).rows);
  await client.end();
})().catch(e=>{console.error(e);process.exit(1)});
