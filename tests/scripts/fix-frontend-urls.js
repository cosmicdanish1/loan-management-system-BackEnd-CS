const fs = require('fs');
const path = require('path');

function walk(dir, callback) {
    fs.readdirSync(dir).forEach(f => {
        let dirPath = path.join(dir, f);
        let isDirectory = fs.statSync(dirPath).isDirectory();
        isDirectory ?
            walk(dirPath, callback) : callback(path.join(dir, f));
    });
};

const srcDir = 'f:\\company\\main project\\Frontend\\src';

walk(srcDir, (filePath) => {
    if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
        let content = fs.readFileSync(filePath, 'utf8');
        if (content.includes('localhost:3000')) {
            console.log(`Updating ${filePath}`);
            let newContent = content.replace(/localhost:3000/g, 'localhost:3001');
            fs.writeFileSync(filePath, newContent, 'utf8');
        }
    }
});

console.log('Finished updating URLs');
