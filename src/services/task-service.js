// ============================================================================
// 𝐏ⁿ𝐀 𝐑𝐄𝐖𝐀𝐑𝐃𝐒 — Reward Tasks Service (D1 + Secretary Mode Logging)
// ============================================================================

import { ACTIVITY_ACTIONS, formatINR } from '../config.js';
import {
  completeUserTaskTransaction,
  createTaskRecord,
  getActiveTasks,
  reviewUserTaskTransaction,
} from '../database.js';
import { logAdminActivity } from './activity-log.js';
import { logTaskEvent } from './secretary.js';

export { getActiveTasks };

export async function createRewardTask(env, task, adminId) {
  const created = await createTaskRecord(env, { ...task, createdBy: String(adminId || '') });
  await logAdminActivity(
    env,
    adminId || 'system',
    ACTIVITY_ACTIONS.TASK_CREATED,
    `Created task ${created.id} "${created.title}" (${formatINR(created.rewardPaise)})`
  );
  await logTaskEvent(env, {
    eventSubType: 'CREATED',
    taskId: created.id,
    taskTitle: created.title,
    adminId: String(adminId || ''),
    rewardPaise: created.rewardPaise,
    status: created.status,
    dedupId: `task_created:${created.id}`,
  });
  return created;
}

export async function completeRewardTask(env, { taskId, userId, rewardPaise, taskTitle = '' }) {
  const res = await completeUserTaskTransaction(env, {
    taskId,
    userId,
    rewardPaise,
    completedAt: Date.now(),
  });
  if (res.ok) {
    await logTaskEvent(env, {
      eventSubType: 'COMPLETED',
      taskId,
      taskTitle,
      userId,
      rewardPaise,
      status: 'completed',
      dedupId: `task_completed:${taskId}:${userId}`,
    });
  }
  return res;
}

export async function reviewRewardTaskSubmission(
  env,
  { userTaskId, status, adminId, reviewNote = '' }
) {
  const res = await reviewUserTaskTransaction(env, {
    userTaskId,
    status,
    adminId,
    reviewNote,
    reviewedAt: Date.now(),
  });
  if (res.ok) {
    const ut = res.userTask;
    await logAdminActivity(
      env,
      adminId,
      ACTIVITY_ACTIONS.TASK_REVIEWED,
      `Task submission ${ut.id} (task ${ut.taskId}, user ${ut.userId}) marked ${ut.status.toUpperCase()}${reviewNote ? ` — ${reviewNote}` : ''}`
    );
    await logTaskEvent(env, {
      eventSubType: ut.status.toUpperCase(),
      taskId: ut.taskId,
      userId: ut.userId,
      adminId,
      rewardPaise: ut.status === 'approved' ? ut.rewardPaise : 0,
      status: ut.status,
      note: reviewNote,
      dedupId: `task_review:${ut.id}:${ut.status}`,
    });
  }
  return res;
}
