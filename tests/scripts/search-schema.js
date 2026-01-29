const fs = require('fs');
const content = fs.readFileSync('f:\\company\\main project\\DATABASE_SCHEMA.sql', 'utf8');
const lines = content.split('\n');
lines.forEach((line, index) => {
    if (line.toLowerCase().includes('dividend')) {
        console.log(`Line ${index + 1}: ${line}`);
    }
});
