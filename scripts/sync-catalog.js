/**
 * Rebuilds catalog.json (the prices this server charges) from the shop's index.html.
 * Run whenever products, prices or stock change on the site:
 *     node scripts/sync-catalog.js /path/to/naturaljuices-site/index.html
 */
const fs = require('fs');
const src = process.argv[2];
if (!src) { console.error('Usage: node scripts/sync-catalog.js <path to index.html>'); process.exit(1); }
const html = fs.readFileSync(src, 'utf8');
const start = html.indexOf('const CAT = [');
if (start < 0) throw new Error('Could not find "const CAT = [" in ' + src);
const from = html.indexOf('[', start);
const end = html.indexOf('\n', from);
const cat = JSON.parse(html.slice(from, end).trim().replace(/;$/, ''));
const slim = cat.map(p => ({ id: p.id, name: p.name, price: p.price, out: !!p.out, packs: p.packs || [] }));
const ids = new Set(slim.map(p => p.id));
if (ids.size !== slim.length || slim.some(p => typeof p.id !== 'number' || !(p.price > 0))) throw new Error('Catalog looks wrong — not saved');
fs.writeFileSync(__dirname + '/../catalog.json', JSON.stringify(slim, null, 0).replace(/\},\{/g, '},\n{') + '\n');
console.log('catalog.json updated: ' + slim.length + ' products');
