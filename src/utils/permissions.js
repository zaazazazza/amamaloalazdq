const { getConfig } = require('../database/database');

function hasAnyRole(member, ids) {
  const allowedIds = (Array.isArray(ids) ? ids : ids ? [ids] : []).map(String);
  return member?.roles?.cache?.some(role => allowedIds.includes(String(role.id)));
}
function isStaff(member) {
  return hasAnyRole(member, getConfig('supportRoleIds') || []) || isAdmin(member);
}
function isAdmin(member) {
  return hasAnyRole(member, getConfig('adminRoleIds') || []);
}
module.exports = { hasAnyRole, isStaff, isAdmin };
