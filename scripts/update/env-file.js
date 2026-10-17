'use strict';
// Minimal .env reader so the update scripts do not depend on dotenv being installed.
const fs = require('fs');

function parseEnv(text) {
    const out = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 1) continue;
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        out[line.slice(0, eq).trim()] = value;
    }
    return out;
}

// Loads file into process.env without overriding variables that are already set.
function loadEnvFile(file) {
    if (!fs.existsSync(file)) return {};
    const vars = parseEnv(fs.readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(vars)) if (process.env[k] === undefined) process.env[k] = v;
    return vars;
}

module.exports = { parseEnv, loadEnvFile };
