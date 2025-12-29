const fs = require('fs');
const path = require('path');

try {
    const data = fs.readFileSync(path.join(__dirname, 'mm_cols.json'), 'utf8');
    const cols = JSON.parse(data);
    const memberCols = cols.filter(c => c.column_name.toLowerCase().includes('member') || c.column_name.toLowerCase().includes('mbno'));
    console.log(JSON.stringify(memberCols, null, 2));
} catch (e) { console.error(e); }
