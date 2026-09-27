const { invoiceExists } = require('../database/database');
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomInvoice() {
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}
function generateInvoice() {
  let invoice;
  do invoice = randomInvoice(); while (invoiceExists(invoice));
  return invoice;
}
module.exports = { generateInvoice };
