function money(value) {
  return `${Number(value || 0).toFixed(2)} €`;
}
function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,50) || 'user';
}
function truncate(value, length=100) {
  value = String(value || '');
  return value.length > length ? value.slice(0,length-1)+'…' : value;
}
module.exports = { money, slug, truncate };
