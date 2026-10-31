'use strict';

const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;
const normalize = value => value.toLowerCase().replace(/\s+/g, '');
function refuse(code = 'OWNER_SESSION_INVENTORY_UNAVAILABLE') {
  throw Object.assign(new Error('The session group or activity inventory could not be verified.'), { code });
}
function queryInventory(raw, args) {
  const view = args.view ?? 'sessions';
  if (!['sessions', 'groups'].includes(view) ||
      (args.active_only !== undefined && typeof args.active_only !== 'boolean') ||
      (args.tmux_group !== undefined && (typeof args.tmux_group !== 'string' || !LABEL.test(args.tmux_group)))) {
    refuse('OWNER_INVENTORY_QUERY_INVALID');
  }
  if (!raw || typeof raw.groupingAvailable !== 'boolean' || !Array.isArray(raw.groups) || raw.groups.length > 128 ||
      !Array.isArray(raw.sessions) || raw.sessions.length > 32 || !Number.isFinite(Date.parse(raw.observedAt))) refuse();
  const groups = raw.groups.map(g => {
    if (!g || typeof g.id !== 'string' || !/^\$\d+$/.test(g.id) || typeof g.name !== 'string' || !LABEL.test(g.name)) refuse();
    return { id: g.id, name: g.name };
  });
  if (new Set(groups.map(g => g.id)).size !== groups.length) refuse();
  const sessions = raw.sessions.map(s => {
    if (!s || typeof s.id !== 'string' || !/^os_[A-Za-z0-9]{1,64}$/.test(s.id) || typeof s.label !== 'string' || !LABEL.test(s.label) ||
        !['codex', 'claude'].includes(s.provider) || !['active', 'idle', 'unknown'].includes(s.activity) ||
        !['available', 'unavailable', 'unchecked'].includes(s.availability) ||
        !['native_process', 'resume_launch', 'unknown'].includes(s.membershipBasis) ||
        !Array.isArray(s.groupIds) || s.groupIds.length > 128 ||
        s.groupIds.some(id => !groups.some(g => g.id === id)) ||
        (s.activity !== 'unknown' && (s.availability !== 'available' || !Number.isFinite(Date.parse(s.observedAt))))) refuse();
    return { id: s.id, label: s.label, provider: s.provider, activity: s.activity,
      groupIds: [...new Set(s.groupIds)], membershipBasis: s.membershipBasis,
      availability: s.availability, observedAt: s.observedAt };
  }).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  if (new Set(sessions.map(s => s.id)).size !== sessions.length) refuse();
  if (!raw.groupingAvailable && (groups.length || sessions.some(s => s.groupIds.length))) refuse();
  let selectedGroups = groups;
  if (args.tmux_group !== undefined) {
    if (!raw.groupingAvailable) refuse('OWNER_GROUPS_UNAVAILABLE');
    selectedGroups = groups.filter(g => normalize(g.name) === normalize(args.tmux_group));
    if (selectedGroups.length !== 1) refuse(selectedGroups.length ? 'OWNER_GROUP_AMBIGUOUS' : 'OWNER_GROUP_NOT_FOUND');
  }
  const scoped = args.tmux_group === undefined ? sessions : sessions.filter(s => s.groupIds.includes(selectedGroups[0].id));
  const selected = args.active_only ? scoped.filter(s => s.activity === 'active') : scoped;
  const countedGroups = selectedGroups.map(group => {
    const members = scoped.filter(s => s.groupIds.includes(group.id));
    return {...group, sessionCount: members.length, activeCount: members.filter(s => s.activity === 'active').length,
      unknownCount: members.filter(s => s.activity === 'unknown').length};
  });
  return { view, query_group: args.tmux_group ?? null, active_only: args.active_only === true,
    groups: view === 'groups' && args.active_only
      ? countedGroups.filter(g => g.activeCount > 0) : countedGroups,
    sessions: selected, unknownActivityCount: scoped.filter(s => s.activity === 'unknown').length,
    ungroupedCount: sessions.filter(s => !s.groupIds.length).length,
    groupingAvailable: raw.groupingAvailable, observedAt: raw.observedAt,
    scope: 'enrolled_owner_sessions_in_personal_tmux_groups' };
}

function inventorySpeech(result, cursor = null, continuing = false) {
  const { groups, sessions } = result;
  const items = result.view === 'groups' ? groups.map(group => {
    return `${group.name}: ${group.sessionCount} enrolled session${group.sessionCount === 1 ? '' : 's'}, ${group.activeCount} active${group.unknownCount ? `, ${group.unknownCount} activity unknown` : ''}`;
  }) : sessions.map(s => {
    const names = groups.filter(g => s.groupIds.includes(g.id)).map(g => g.name);
    return `${s.label}, ${s.provider}, ${s.activity === 'unknown' ? 'activity unknown' : s.activity}, ${names.length
      ? `${s.membershipBasis === 'resume_launch' ? 'launched in' : 'in'} ${names.join(' and ')}` : 'group unknown'}`;
  });
  // Restart pagination when scope, identities or observed state changes.
  const key = JSON.stringify([result.view, result.query_group, result.active_only, items]);
  const offset = continuing && cursor?.key === key ? cursor.offset : 0;
  const shown = items.slice(offset, offset + 5);
  const remaining = Math.max(0, items.length - offset - shown.length);
  const title = result.view === 'groups' ? 'Tmux groups' : 'Enrolled agent sessions';
  let text = shown.length ? `${title}${result.query_group ? ` in ${result.query_group}` : ''}: ${shown.join('; ')}.`
    : result.view === 'groups' && !result.groupingAvailable ? 'Tmux groups are unavailable.'
      : offset ? 'There are no more entries in this list.'
      : result.active_only ? 'No active enrolled sessions were observed in this scope.'
        : `No ${result.view === 'groups' ? 'personal tmux groups' : 'enrolled sessions'} were found in this scope.`;
  if (!result.groupingAvailable && result.view !== 'groups') text += ' Tmux groups are unavailable.';
  if (result.active_only && result.unknownActivityCount) text += ` Activity is unknown for ${result.unknownActivityCount} other sessions.`;
  if (result.view === 'groups' && result.ungroupedCount) text += ` ${result.ungroupedCount} enrolled session${result.ungroupedCount === 1 ? ' has' : 's have'} no known group.`;
  if (remaining) text += ` ${remaining} more entries. Say next ${result.view} to continue.`;
  return { text, cursor: { key, offset: offset + shown.length } };
}

module.exports = { queryInventory, inventorySpeech };
