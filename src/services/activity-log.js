// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Admin Activity Log Service
// ============================================================================

import { generateId } from '../config.js';
import { appendActivityLog } from '../database.js';

export async function logAdminActivity(env, adminId, action, details = '') {
  const entry = {
    id: generateId('LOG'),
    adminId: String(adminId),
    action: String(action),
    details: String(details || '').slice(0, 500),
    timestamp: Date.now(),
  };
  await appendActivityLog(env, entry);
  return entry;
}
