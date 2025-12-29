const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, 'src', '..', '.env');

try {
    let envContent = fs.readFileSync(envPath, 'utf8');

    if (envContent.includes('JWT_EXPIRES_IN=')) {
        // Replace existing value
        envContent = envContent.replace(/JWT_EXPIRES_IN=.*/g, 'JWT_EXPIRES_IN=12h');
        console.log('Updated existing JWT_EXPIRES_IN to 12h');
    } else {
        // Append new value
        // ensure newline before appending if not present
        if (!envContent.endsWith('\n')) {
            envContent += '\n';
        }
        envContent += 'JWT_EXPIRES_IN=12h\n';
        console.log('Added JWT_EXPIRES_IN=12h');
    }

    // Also checking for Refresh Token Expiration usually paired with it
    if (envContent.includes('JWT_REFRESH_EXPIRES_IN=')) {
        envContent = envContent.replace(/JWT_REFRESH_EXPIRES_IN=.*/g, 'JWT_REFRESH_EXPIRES_IN=7d'); // verify refresh is long enough
    } else {
        if (!envContent.endsWith('\n')) {
            envContent += '\n';
        }
        envContent += 'JWT_REFRESH_EXPIRES_IN=7d\n';
    }

    fs.writeFileSync(envPath, envContent, 'utf8');
    console.log('Successfully updated .env file');
} catch (error) {
    console.error('Error updating .env file:', error);
    process.exit(1);
}
