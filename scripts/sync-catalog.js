/**
 * Rebuilds catalog.json (the prices this server charges) from the shop's index.html.
 * Run whenever products, prices or stock change on the site:
 *     node scripts/sync-catalog.js /path/to/naturaljuices-site/index.html
 */
const fs = require('fs');
const src = process.argv[2];
if (!src) { console.error('Usage: node scripts/sync-catalog.js <path to index.html>'); process.exit(1); }
const html = fs.readFileSync(src, 'utf8');
const slim = require('./parse-catalog')(html);
fs.writeFileSync(__dirname + '/../catalog.json', JSON.stringify(slim, null, 0).replace(/\},\{/g, '},\n{') + '\n');
console.log('catalog.json updated: ' + slim.length + ' products');
