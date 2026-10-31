'use strict';

// A bounded, on-demand sample. No history, terminal output, delivery or agent
// launch. Missing observations stay unknown, including the unvisited tail.
async function collectInventory(entries, { topology, inspect, now = Date.now, budgetMs = 6000 }) {
  const started = now();
  let placement;
  try { placement = await topology(entries); }
  catch { placement = { available: false, groups: [], memberships: {} }; }
  const sessions = [];
  for (const entry of entries) {
    let activity = 'unknown'; let availability = 'unchecked'; let observedAt = null;
    const remaining = budgetMs - (now() - started);
    if (remaining > 0) {
      try {
        const status = await inspect(entry.id, Math.min(remaining, 600));
        activity = ['active', 'busy'].includes(status) ? 'active' : status === 'idle' ? 'idle' : 'unknown';
        availability = 'available'; observedAt = new Date(now()).toISOString();
      } catch { availability = 'unavailable'; }
    }
    const member = placement.memberships[entry.id];
    sessions.push({ id: entry.id, label: entry.label, provider: entry.provider,
      activity, availability, observedAt, groupIds: member?.groups || [],
      membershipBasis: member?.basis || 'unknown' });
  }
  return { groups: placement.groups, sessions, groupingAvailable: placement.available,
    observedAt: new Date(started).toISOString(),
    scope: 'enrolled_owner_sessions_in_personal_tmux_groups',
    activityComplete: sessions.every(s => s.activity !== 'unknown'),
    // Codex's resume launch association does not prove the displayed thread.
    tmuxPaneBinding: false };
}

module.exports = { collectInventory };
