const fs = require('fs');
const path = require('path');
const defaults = require('../config/defaultConfig');
const { queueDocument, syncJsonFile } = require('../services/remoteStore');

// Toujours enregistrer les données dans le dossier du bot, même si le bot est lancé
// depuis un autre répertoire. Cela évite de créer plusieurs sicario.json différents.
const dataDir = path.resolve(__dirname, '../../data');
const dataFile = path.join(dataDir, 'sicario.json');
const backupFile = path.join(dataDir, 'sicario.json.bak');
fs.mkdirSync(dataDir, { recursive: true });

function fresh() {
  return { config: {}, tickets: [], orders: [], products: [], counters: { ticketId: 0, productId: 0, orderId: 0 } };
}
let state = fresh();

function applyLoaded(loaded) {
  state = { ...fresh(), ...(loaded && typeof loaded === 'object' ? loaded : {}) };
  state.config ||= {};
  state.tickets ||= [];
  state.orders ||= [];
  state.products ||= [];
  state.counters ||= { ticketId: 0, productId: 0, orderId: 0 };
  state.counters = { ticketId: 0, productId: 0, orderId: 0, ...state.counters };
  state.products = state.products.map(p => ({
    ...p,
    variants: Array.isArray(p.variants)
      ? p.variants.map(v => ({ name: String(v.name || 'Standard'), price: Number(v.price) || 0 }))
      : [{ name: 'Standard', price: 0 }]
  }));
}

function load() {
  if (!fs.existsSync(dataFile)) return;
  try {
    applyLoaded(JSON.parse(fs.readFileSync(dataFile, 'utf8')));
  } catch (e) {
    console.error('Impossible de lire data/sicario.json, tentative avec la sauvegarde.', e.message);
    try {
      applyLoaded(JSON.parse(fs.readFileSync(backupFile, 'utf8')));
    } catch (_) {
      state = fresh();
    }
  }
}
function save() {
  // Écriture atomique : on écrit d'abord un fichier temporaire puis on le remplace.
  // Si le bot est interrompu pendant l'écriture, le JSON principal reste intact.
  const json = JSON.stringify(state, null, 2);
  const tempFile = `${dataFile}.tmp`;
  fs.writeFileSync(tempFile, json, 'utf8');
  try {
    if (fs.existsSync(dataFile)) fs.copyFileSync(dataFile, backupFile);
  } catch (_) {}
  fs.renameSync(tempFile, dataFile);
  queueDocument('sicario', state);
}

async function syncFromRemote() {
  const remote = await syncJsonFile({ key: 'sicario', file: dataFile, defaultValue: fresh() });
  if (remote) {
    applyLoaded(remote);
    initConfig();
  }
  return state;
}
function initConfig() {
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in state.config)) state.config[key] = value;
  }

  // Migration: anciennes installations pouvaient avoir ces catégories à null.
  // On applique la catégorie demandée sans écraser une catégorie personnalisée.
  if (!state.config.supportCategoryId) state.config.supportCategoryId = defaults.supportCategoryId;
  if (!state.config.orderCategoryId) state.config.orderCategoryId = defaults.orderCategoryId;

  if (!state.products.length) {
    const products = [
      ['Accès Générateur', 'Accès au générateur SICARIO SH.', [{ name:'1 Jour',price:0 },{ name:'3 Jours',price:0 },{ name:'1 Semaine',price:0 },{ name:'À vie',price:0 }]],
      ['Bots', 'Services et bots.', [{ name:'Standard',price:0 }]],
      ['Sica Check', 'Service Sica Check.', [{ name:'Standard',price:0 }]],
      ['Logs', 'Service Logs.', [{ name:'Standard',price:0 }]],
      ['Telegram To Num', 'Service Telegram To Num.', [{ name:'Standard',price:0 }]]
    ];
    for (const [name, description, variants] of products) createProduct(name, description, variants, false);
  }
  save();
}
load();

function getConfig(key) { return key in state.config ? state.config[key] : defaults[key]; }
function setConfig(key, value) { state.config[key] = value; save(); }
function allConfig() { return { ...defaults, ...state.config }; }

function getProducts(activeOnly=true) {
  return state.products.filter(p => !activeOnly || p.active).map(p => ({ ...p, variants: p.variants || [] }));
}
function getProduct(id) {
  const p = state.products.find(p => p.id === Number(id));
  return p ? { ...p, variants: p.variants || [] } : null;
}
function getProductByName(name) {
  const p = state.products.find(p => p.name === name);
  return p ? { ...p, variants: p.variants || [] } : null;
}
function createProduct(name, description='', variants=[{name:'Standard',price:0}], persist=true) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Le nom du produit est obligatoire.');
  if (state.products.some(p => p.name.toLowerCase() === cleanName.toLowerCase())) throw new Error('Ce produit existe déjà.');
  const cleanVariants = (Array.isArray(variants) && variants.length ? variants : [{ name: 'Standard', price: 0 }])
    .map(v => ({ name: String(v.name || 'Standard').trim(), price: Number(v.price) || 0 }));
  const p = { id: ++state.counters.productId, name: cleanName, description: String(description || '').trim(), active:true, variants: cleanVariants };
  state.products.push(p);
  if (persist) save();
  return { ...p };
}
function updateProduct(id, data) {
  const i = state.products.findIndex(p => p.id === Number(id));
  if (i === -1) return null;
  state.products[i] = { ...state.products[i], ...data };
  if (data.name !== undefined) state.products[i].name = String(data.name || '').trim();
  if (data.description !== undefined) state.products[i].description = String(data.description || '').trim();
  if (data.variants !== undefined) {
    state.products[i].variants = (Array.isArray(data.variants) && data.variants.length ? data.variants : [{ name: 'Standard', price: 0 }])
      .map(v => ({ name: String(v.name || 'Standard').trim(), price: Number(v.price) || 0 }));
  }
  save();
  return { ...state.products[i] };
}
function deleteProduct(id) {
  const i = state.products.findIndex(p => p.id === Number(id));
  if (i === -1) return { changes:0 };
  state.products.splice(i,1); save(); return { changes:1 };
}

function nextSupportSequence() {
  return state.tickets.filter(t=>t.type==='support').reduce((m,t)=>Math.max(m,t.sequence||0),0)+1;
}
function createTicket(data) {
  const t = { id:++state.counters.ticketId, assigned_to:null, status:'open', closed_at:null, closed_by:null, ...(data.type==='support'?{last_activity_at:data.created_at||Date.now(),last_reminded_at:null}:{}), ...data };
  state.tickets.push(t); save(); return { ...t };
}
function getTicketByChannel(channelId) { return state.tickets.find(t=>t.channel_id===channelId) || null; }
function getOpenSupportTickets() { return state.tickets.filter(t=>t.type==='support'&&t.status==='open').map(t=>({...t})); }
function recordTicketActivity(channelId,activityAt=Date.now()) {
  const t=getTicketByChannel(channelId);
  if(!t||t.type!=='support'||t.status!=='open') return null;
  t.last_activity_at=activityAt;t.last_reminded_at=null;save();return {...t};
}
function markTicketReminderSent(channelId,remindedAt=Date.now()) {
  const t=getTicketByChannel(channelId);
  if(!t||t.type!=='support'||t.status!=='open') return false;
  t.last_reminded_at=remindedAt;save();return true;
}
function findOpenSupportByCreator(userId) { return state.tickets.find(t=>t.creator_id===userId && t.type==='support' && t.status==='open') || null; }
function countOpenTicketsByCreator(userId) {
  const support = state.tickets.filter(t=>t.creator_id===userId && t.status==='open').length;
  const orders = state.orders.filter(o=>o.user_id===userId && o.status==='pending').length;
  return support + orders;
}
function cleanupStaleTickets(existingChannelIds) {
  const ids = new Set(Array.from(existingChannelIds || [], String));
  let ticketsFixed = 0;
  let ordersFixed = 0;
  const now = Date.now();

  for (const ticket of state.tickets) {
    if (ticket.status === 'open' && ticket.channel_id && !ids.has(String(ticket.channel_id))) {
      ticket.status = 'closed';
      ticket.closed_at = now;
      ticket.closed_by = 'system:stale-ticket-reset';
      ticketsFixed++;
    }
  }

  for (const order of state.orders) {
    if (order.status === 'pending' && order.channel_id && !ids.has(String(order.channel_id))) {
      order.status = 'cancelled';
      order.counted = 0;
      order.processed_at = now;
      order.processed_by = 'system:stale-ticket-reset';
      ordersFixed++;
    }
  }

  if (ticketsFixed || ordersFixed) save();
  return { ticketsFixed, ordersFixed };
}

function resetAllOpenTicketRecords() {
  const now = Date.now();
  let ticketsFixed = 0;
  let ordersFixed = 0;

  for (const ticket of state.tickets) {
    if (ticket.status === 'open') {
      ticket.status = 'closed';
      ticket.closed_at = now;
      ticket.closed_by = 'system:manual-ticket-reset';
      ticketsFixed++;
    }
  }

  for (const order of state.orders) {
    if (order.status === 'pending') {
      order.status = 'cancelled';
      order.counted = 0;
      order.processed_at = now;
      order.processed_by = 'system:manual-ticket-reset';
      ordersFixed++;
    }
  }

  if (ticketsFixed || ordersFixed) save();
  return { ticketsFixed, ordersFixed };
}

function assignTicket(channelId,userId) {
  const t=getTicketByChannel(channelId);
  if(!t || t.status!=='open') return null;
  // Un ticket déjà pris par un autre membre du staff ne peut pas être repris.
  if(t.assigned_to && String(t.assigned_to)!==String(userId)) return null;
  t.assigned_to=userId; save(); return {...t};
}
function releaseTicket(channelId) {
  const t=getTicketByChannel(channelId); if(!t||t.status!=='open') return t;
  t.assigned_to=null; save(); return {...t};
}
function closeTicket(channelId,closedBy) {
  const t=getTicketByChannel(channelId); if(!t) return null;
  if(t.status!=='closed'){t.status='closed';t.closed_at=Date.now();t.closed_by=closedBy;save();}
  return {...t};
}
function rateSupportTicket(ticketId,userId,rating) {
  const score=Number(rating);
  if(!Number.isInteger(score)||score<1||score>5) return {ok:false,reason:'invalid_rating'};
  const t=state.tickets.find(ticket=>String(ticket.id)===String(ticketId)&&ticket.type==='support');
  if(!t) return {ok:false,reason:'not_found'};
  if(String(t.creator_id)!==String(userId)) return {ok:false,reason:'not_allowed'};
  if(t.status!=='closed') return {ok:false,reason:'not_closed'};
  if(t.rating!=null) return {ok:false,reason:'already_rated'};
  t.rating=score;t.rated_at=Date.now();save();return {ok:true,ticket:{...t}};
}

function createOrder(data) {
  const o={ id:++state.counters.orderId,status:'pending',counted:0,processed_at:null,processed_by:null,...data };
  state.orders.push(o);save();return {...o};
}
function getOrder(invoice){return state.orders.find(o=>o.invoice===invoice)||null;}
function getOrderByChannel(channelId){return state.orders.find(o=>o.channel_id===channelId)||null;}
function getOrders(status){return state.orders.filter(o=>!status||o.status===status).sort((a,b)=>b.created_at-a.created_at).map(o=>({...o}));}
function invoiceExists(invoice){return !!getOrder(invoice);}
function cancelOrderByChannel(channelId, userId=null){
  const o=state.orders.find(x=>x.channel_id===channelId && x.status==='pending');
  if(!o) return null;
  o.status='cancelled'; o.counted=0; o.processed_at=Date.now(); o.processed_by=userId; save(); return {...o};
}
function processOrder(invoice,status,staffId){
  const o=getOrder(invoice); if(!o||o.status!=='pending') return {ok:false,order:o};
  o.status=status;o.counted=status==='accepted'?1:0;o.processed_at=Date.now();o.processed_by=staffId;save();
  return {ok:true,order:{...o}};
}
function dashboard(){
  const accepted=state.orders.filter(o=>o.status==='accepted');
  const total=accepted.reduce((n,o)=>n+Number(o.total_price||0),0);
  const base=accepted.reduce((n,o)=>n+Number(o.base_price||0),0);
  const fees=accepted.reduce((n,o)=>n+Number(o.fee||0),0);
  const uniqueClients=new Set(accepted.map(o=>o.user_id)).size;
  const byPayment={},byProduct={};
  for(const o of accepted){
    byPayment[o.payment_method]=(byPayment[o.payment_method]||0)+Number(o.total_price||0);
    byProduct[o.product]=(byProduct[o.product]||0)+1;
  }
  return {total,base,fees,uniqueClients,orders:accepted.length,byPayment,byProduct};
}

initConfig();

// Compatibility object: only the legacy query used by ticketService.
const db = {
  prepare(sql) {
    return {
      get(...args) {
        if (/SELECT \* FROM tickets WHERE creator_id=\? AND type='support' AND status='open'/i.test(sql)) return findOpenSupportByCreator(args[0]);
        return undefined;
      }
    };
  }
};

module.exports={db,getConfig,setConfig,allConfig,getProducts,getProduct,getProductByName,createProduct,updateProduct,deleteProduct,nextSupportSequence,createTicket,getTicketByChannel,getOpenSupportTickets,recordTicketActivity,markTicketReminderSent,findOpenSupportByCreator,countOpenTicketsByCreator,cleanupStaleTickets,resetAllOpenTicketRecords,assignTicket,releaseTicket,closeTicket,rateSupportTicket,createOrder,getOrder,getOrderByChannel,getOrders,invoiceExists,processOrder,cancelOrderByChannel,dashboard,syncFromRemote};
