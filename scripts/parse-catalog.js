/** Reads the product list (const CAT = [...]) out of the shop's index.html and keeps what pricing needs. */
module.exports = function parseCatalog(html) {
  const start = html.indexOf('const CAT = [');
  if (start < 0) throw new Error('Could not find "const CAT = [" in the shop page');
  const from = html.indexOf('[', start);
  const end = html.indexOf('\n', from);
  const cat = JSON.parse(html.slice(from, end).trim().replace(/;$/, ''));
  const slim = cat.map(p => ({ id: p.id, name: p.name, price: p.price, out: !!p.out, packs: p.packs || [] }));
  const ids = new Set(slim.map(p => p.id));
  if (slim.length < 10 || ids.size !== slim.length || slim.some(p => typeof p.id !== 'number' || !(p.price > 0) ||
      !Array.isArray(p.packs) || p.packs.some(k => typeof k[0] !== 'string' || !(k[1] > 0)))) throw new Error('Catalog looks wrong');
  return slim;
};
