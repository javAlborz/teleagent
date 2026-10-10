'use strict';

const crypto = require('node:crypto');
const {labelKey, validLabel, checkOwnerInstruction} = require('./owner-call-intent');

const ACTIONS = ['inspect_owner_session', 'request_owner_instruction', 'get_owner_reply', 'get_owner_instruction'];
const MAX_ACTIONS = 32; // Matches the admitted session catalog, not a daily allowance.
const operationId = value => /^job_[a-f0-9]{64}$/.test(value || '');
const copy = value => structuredClone(value);
const fail = code => { throw Object.assign(new Error(code), {code}); };
const excerpt = (text, limit = 1200) => String(text || '').slice(0, limit);
const makeOperationId = (session, action) => 'job_' + crypto.createHash('sha256')
  .update(JSON.stringify([session, action])).digest('hex');
const attempted = task => ['dispatching', 'accepted', 'submitted_unconfirmed', 'outcome_unknown'].includes(task.state);

function currentAuthorization(transcript, text) {
  return typeof transcript === 'string' && typeof text === 'string' && text.trim().length >= 3 &&
    transcript.includes(text) && transcript.indexOf(text) === transcript.lastIndexOf(text);
}

// Durable application state, distinct from quoted native output and model prose.
// Loading it never starts work. An interrupted delivery is reconciled by its ID,
// and an unstarted item needs a new caller instruction before it can be sent.
class OwnerTaskMemory {
  constructor(store = null, operationForAction = null) {
    this.store = store;
    this.operationForAction = operationForAction;
    const loaded = store?.load?.();
    this.revision = loaded?.revision || 0;
    this.value = loaded?.state || {version: 1, selected_sessions: [], groups: [], tasks: []};
    this.persisted = copy(this.value);
    this.writeFailed = false;
    if (this.value.version !== 1 || !Array.isArray(this.value.tasks) || !Array.isArray(this.value.groups)) {
      fail('OWNER_DIALOGUE_STATE_INVALID');
    }
  }
  commit() {
    try {
      if (this.writeFailed) fail('OWNER_DIALOGUE_STATE_CONFLICT');
      if (Buffer.byteLength(JSON.stringify(this.value)) > 512 * 1024) fail('OWNER_DIALOGUE_STATE_FULL');
      if (this.store) this.revision = this.store.save(this.revision, copy(this.value));
      this.persisted = copy(this.value);
    } catch (error) {
      this.value = copy(this.persisted);
      this.writeFailed = true; // A stale writer cannot resume effects in this call.
      throw error;
    }
  }
  select(labels, groupName) {
    if (!Array.isArray(labels) || labels.length > MAX_ACTIONS || labels.some(label => !validLabel(label)) ||
        new Set(labels.map(labelKey)).size !== labels.length) fail('OWNER_PLAN_TARGETS_INVALID');
    if (labels.length) this.value.selected_sessions = [...labels];
    if (groupName !== undefined) {
      if (!validLabel(groupName) || !labels.length) fail('OWNER_PLAN_GROUP_INVALID');
      this.value.groups = this.value.groups.filter(g => labelKey(g.name) !== labelKey(groupName));
      this.value.groups.push({name: groupName, sessions: [...labels]});
      this.value.groups = this.value.groups.slice(-16);
    } else if (labels.length > 1 && !this.value.groups.some(g => JSON.stringify(g.sessions) === JSON.stringify(labels))) {
      this.value.groups.push({name: null, sessions: [...labels]});
      this.value.groups = this.value.groups.slice(-16);
    }
    this.commit();
  }
  get(id) { return this.value.tasks.find(t => t.id === id); }
  latest(label) {
    return [...this.value.tasks].reverse().find(t => t.action === 'request_owner_instruction' &&
      labelKey(t.session_label) === labelKey(label));
  }
  reserve(actions, turnKey, singleActionId = null) {
    const prior = this.value.tasks.filter(t => t.turn_key === turnKey);
    if (prior.length) return prior;
    // Retain unfinished records; evict the oldest finished/read snapshots first.
    const protectedState = new Set(['pending', 'dispatching', 'outcome_unknown', 'submitted_unconfirmed']);
    while (this.value.tasks.length + actions.length > 96) {
      const index = this.value.tasks.findIndex(t => !protectedState.has(t.state) &&
        (t.state !== 'accepted' || ['completed', 'failed', 'interrupted'].includes(t.work_state)));
      if (index < 0) fail('OWNER_DIALOGUE_PENDING_FULL');
      this.value.tasks.splice(index, 1);
    }
    const planId = 'plan_' + crypto.randomUUID().replaceAll('-', '');
    const tasks = actions.map(action => {
      this.value.next_task = (this.value.next_task || 0) + 1;
      const id = singleActionId && actions.length === 1 ? singleActionId : `task_${this.value.next_task}`;
      return {...copy(action), id, plan_id: planId, turn_key: turnKey, state: 'pending',
        operation_id: action.action === 'request_owner_instruction' && this.operationForAction
          ? this.operationForAction(id) : action.operation_id || null};
    });
    for (const task of tasks) {
      if (Number.isInteger(task.depends_on)) {
        const source = tasks[task.depends_on];
        task.source_task_id = source.id;
        task.operation_id = source.operation_id;
      }
    }
    for (const task of tasks) {
      const prior = this.get(task.reference_task_id);
      if (prior && !attempted(prior) && labelKey(prior.session_label) === labelKey(task.session_label)) {
        Object.assign(prior, {state: 'superseded', replacement: task.id});
      }
    }
    this.value.tasks.push(...tasks);
    this.commit(); // All requested items exist before the first possible effect.
    return tasks;
  }
  update(task, patch) { Object.assign(task, patch); this.commit(); }
  context() {
    return {selected_sessions: this.value.selected_sessions, groups: this.value.groups,
      tasks: this.value.tasks.slice(-48).map(t => ({id: t.id, session_label: t.session_label,
        action: t.action, message: t.message, state: t.state,
        result: t.reply_result || t.result, work_state: t.work_state || null, notify_when_complete: t.notify_when_complete === true}))};
  }
}

function validatePlan(plan, {transcript, labels, memory, draft, awaitingMessage}) {
  if (!plan || !Array.isArray(plan.actions) || !plan.actions.length || plan.actions.length > MAX_ACTIONS) {
    fail('OWNER_PLAN_INVALID');
  }
  const plannedSends = new Map();
  const actions = plan.actions.map((item, index) => {
    if (!item || !ACTIONS.includes(item.action)) fail('OWNER_PLAN_ACTION_INVALID');
    const action = {action: item.action};
    if (['get_owner_reply', 'get_owner_instruction'].includes(item.action)) {
      const planned = !item.task_id && !item.operation_id && plannedSends.get(labelKey(item.session_label));
      if (planned) return {...action, session_label: planned.label, depends_on: planned.index,
        notify_when_complete: item.notify_when_complete === true};
      const target = item.task_id ? memory.get(item.task_id)
        : item.operation_id ? memory.value.tasks.find(t => t.operation_id === item.operation_id)
          : validLabel(item.session_label) ? memory.latest(item.session_label) : null;
      if (!target) fail('OWNER_PLAN_REFERENCE_INVALID');
      if (target.action === 'request_owner_instruction' && !attempted(target)) {
        return {...action, session_label: target.session_label, unsent_task_id: target.id};
      }
      if (!operationId(target.operation_id)) fail('OWNER_PLAN_REFERENCE_INVALID');
      Object.assign(action, {operation_id: target.operation_id, session_label: target.session_label,
        notify_when_complete: item.notify_when_complete === true});
      return action;
    }
    if (!validLabel(item.session_label)) fail('OWNER_PLAN_TARGETS_INVALID');
    const matches = labels.filter(label => labelKey(label) === labelKey(item.session_label));
    if (matches.length > 1) fail('OWNER_PLAN_TARGETS_INVALID');
    action.session_label = matches[0] || item.session_label;
    if (item.action === 'inspect_owner_session') {
      action.history = item.history !== false;
      if (item.selection) action.selection = copy(item.selection);
      // A request for the result of a known instruction must never substitute
      // an unrelated greeting, even when that instruction was not sent.
      const prior = memory.latest(action.session_label);
      if (action.history && !action.selection && item.unrelated_history !== true && prior) {
        if (operationId(prior.operation_id) && attempted(prior)) {
          action.action = 'get_owner_reply'; action.operation_id = prior.operation_id;
        } else action.unsent_task_id = prior.id;
      }
      action.notify_when_complete = item.notify_when_complete === true;
      return action;
    }
    const source = item.message_source;
    let message;
    if (source === 'caller' || source === 'draft') {
      const checked = checkOwnerInstruction(transcript, item,
        {kind: source, text: item.message, draft_id: item.draft_id}, {labels, draft, awaitingMessage});
      if (!checked.instruction) fail('OWNER_PLAN_MESSAGE_' + checked.reason.toUpperCase());
      message = checked.instruction.message;
    } else if (source === 'reference' || source === 'delegation') {
      // The decision model interprets authorization, while code binds it to a
      // current caller excerpt. Retrieved text never supplies this excerpt.
      if (!currentAuthorization(transcript, item.authorization_text)) fail('OWNER_PLAN_AUTHORIZATION_MISSING');
      if (source === 'reference') {
        const ref = memory.get(item.task_id);
        if (!ref || ref.action !== 'request_owner_instruction' || !ref.message) fail('OWNER_PLAN_REFERENCE_INVALID');
        if (attempted(ref) && labelKey(ref.session_label) === labelKey(action.session_label) &&
            item.repeat_delivery !== true) fail('OWNER_PLAN_ALREADY_ATTEMPTED');
        if (item.message !== undefined && item.message !== ref.message) fail('OWNER_PLAN_REFERENCE_CHANGED');
        message = ref.message;
      } else message = item.message;
    } else fail('OWNER_PLAN_MESSAGE_SOURCE_INVALID');
    if (typeof message !== 'string' || !message.trim() || message.length > 1200) fail('OWNER_PLAN_MESSAGE_INVALID');
    Object.assign(action, {message, message_source: source,
      reference_task_id: source === 'reference' ? item.task_id : null,
      authorization_text: item.authorization_text || null, notify_when_complete: item.notify_when_complete === true});
    plannedSends.set(labelKey(action.session_label), {label: action.session_label, index});
    return action;
  });
  const sends = actions.filter(a => a.action === 'request_owner_instruction').map(a => `${labelKey(a.session_label)}\0${a.message}`);
  if (new Set(sends).size !== sends.length) fail('OWNER_PLAN_DUPLICATE_INSTRUCTION');
  const targets = [...new Set(actions.map(a => a.session_label))];
  const group = memory.value.selected_sessions;
  let selected = plan.selected_sessions || targets;
  if (plan.replace_group !== true && group.length > 1 && selected.length &&
      selected.every(t => group.some(g => labelKey(g) === labelKey(t)))) selected = group;
  // Validate the group before reserving or executing any task.
  if (!Array.isArray(selected) || selected.length > MAX_ACTIONS || selected.some(s => !validLabel(s)) ||
      new Set(selected.map(labelKey)).size !== selected.length ||
      (plan.group_name !== undefined && !validLabel(plan.group_name))) fail('OWNER_PLAN_TARGETS_INVALID');
  return {actions, selected, groupName: plan.group_name};
}

function resultSnapshot(output) {
  const result = output?.result || {};
  const turn = result.history?.latestTurn;
  const selected = result.history?.selection;
  const reply = selected ? result.history?.selectedMessage : turn?.reply;
  return {success: output?.success === true, code: output?.code || null,
    delivery_state: result.state || null, activity: result.status || null,
    turn_status: selected ? null : turn?.status || null, reply: reply?.text ? excerpt(reply.text, 2400) : null,
    ...(selected ? {selection: copy(selected), selected_role: reply?.role || null} : {})};
}

// The executor receives validated actions only. It never retries a send: status
// reads reconcile a dispatching receipt. A new caller turn fences unstarted work.
async function runPlan(tasks, {memory, execute, current, delay = ms => new Promise(r => setTimeout(r, ms))}) {
  for (const task of tasks) {
    if (!current()) break;
    if (task.state !== 'pending') continue;
    const source = task.source_task_id && memory.get(task.source_task_id);
    if (task.unsent_task_id || (source && !attempted(source))) {
      memory.update(task, {state: 'not_sent', result: {success: false, code: 'OWNER_INSTRUCTION_NOT_SENT'}});
      continue;
    }
    memory.update(task, {state: 'dispatching'});
    let output;
    try { output = await execute(task); }
    catch (error) { output = {success: false, code: error.code || 'OWNER_PLAN_OUTCOME_UNKNOWN',
      delivery_attempted: task.action === 'request_owner_instruction'}; }
    if (task.operation_id && output?.operation_id && task.operation_id !== output.operation_id) {
      memory.update(task, {state: 'outcome_unknown', result: {success: false, code: 'OWNER_PLAN_OPERATION_CHANGED'}});
      break;
    }
    const op = task.operation_id || output?.operation_id;
    if (op && operationId(op)) memory.update(task, {operation_id: op});
    // Do not overlap the controller's admission slot with a following request.
    for (let i = 0; task.action === 'request_owner_instruction' && output?.success === true &&
        output.result?.state === 'dispatching' && operationId(op) && current() && i < 30; i++) {
      await delay(200);
      try {
        const status = await execute({action: 'get_owner_instruction', operation_id: op,
          session_label: task.session_label, id: `${task.id}_status_${i}`});
        if (status?.success === true && status.result?.state) output = status;
      } catch { break; }
    }
    const result = resultSnapshot(output);
    const state = task.action === 'request_owner_instruction'
      ? (result.delivery_state === 'not_found' ? 'outcome_unknown' : result.delivery_state ||
        (result.success || output?.delivery_attempted === true ? 'outcome_unknown' : 'failed'))
      : result.success ? 'read' : 'failed';
    memory.update(task, {state, result});
    if (task.action === 'get_owner_reply' && result.success && op) {
      const original = memory.value.tasks.find(t => t.action === 'request_owner_instruction' && t.operation_id === op);
      if (original) memory.update(original, {work_state: result.turn_status});
    }
    // A GET can overtake a still-preparing POST. Absence of a row does not
    // prove that the earlier send is quiescent or authorize a fresh attempt.
    if (task.action === 'get_owner_instruction' && result.success && op && result.delivery_state &&
        result.delivery_state !== 'not_found') {
      const original = memory.value.tasks.find(t => t.action === 'request_owner_instruction' && t.operation_id === op);
      if (original) memory.update(original, {state: result.delivery_state});
    }
    if (task.action === 'request_owner_instruction' && ['dispatching', 'outcome_unknown'].includes(state)) break;
  }
  return tasks;
}

function renderPlan(tasks) {
  const perReplyWords = Math.max(2, Math.floor(150 / Math.max(tasks.length, 1)));
  const lines = tasks.map(task => {
    const label = task.session_label;
    const result = task.result || {};
    if (task.state === 'pending') return `${label}: not sent or checked yet; that part is still pending.`;
    if (task.state === 'not_sent') return `${label}: that instruction was not sent, so there is no result for it.`;
    if (task.action === 'request_owner_instruction' || task.action === 'get_owner_instruction') {
      const state = result.delivery_state || task.state;
      if (result.code === 'OWNER_SESSION_NOT_ENROLLED') return `${label}: session not found; instruction not sent.`;
      if (result.code === 'OWNER_SESSION_TARGET_AMBIGUOUS') return `${label}: name is ambiguous; instruction not sent.`;
      if (['OWNER_APPROVAL_BUSY', 'OWNER_BROKER_BUSY'].includes(result.code)) return `${label}: busy; instruction not sent.`;
      return `${label}: ` + ({accepted: 'instruction accepted; its work is not confirmed complete.',
        dispatching: 'delivery is still pending.', submitted_unconfirmed: 'submitted; acceptance is not confirmed.',
        outcome_unknown: 'delivery is uncertain; I will not resend it.', refused: 'instruction was not sent.',
        canceled: 'delivery canceled.', not_found: 'no delivery record found.'}[state] || 'delivery could not be confirmed.');
    }
    if (!result.success) return `${label}: I could not retrieve that result.`;
    if (task.history === false) return `${label}: ` +
      (['active', 'busy', 'running', 'inProgress'].includes(result.activity) ? 'working.' : result.activity === 'idle' ? 'idle.' : 'activity unknown.');
    if (!result.reply) return `${label}: ` + (result.turn_status === 'inProgress' ? 'still working; no reply yet.'
      : ['failed', 'interrupted'].includes(result.turn_status) ? `${result.turn_status}; no reply available.` : 'no reply available for that turn.');
    const words = result.reply.trim().split(/\s+/);
    const text = words.slice(0, perReplyWords).join(' ');
    const prefix = result.selection ? `selected historical ${result.selected_role || 'message'}: `
      : result.turn_status === 'inProgress' ? 'still working; latest saved reply: '
        : ['failed', 'interrupted', 'unknown'].includes(result.turn_status) ? `${result.turn_status}; latest saved reply: ` : 'reply: ';
    return `${label}: ${prefix}${text}` +
      (words.length > perReplyWords ? ' [excerpt; ask to hear more].' : '');
  });
  const page = []; let words = 0;
  for (const line of lines) {
    const count = line.split(/\s+/).length;
    if (page.length && words + count > 190) break;
    words += count; page.push(line);
  }
  const remaining = lines.length - page.length;
  return page.join(' ') + (remaining ? ` ${remaining} more task results are saved; ask for the remaining results.` : '');
}

module.exports = {OwnerTaskMemory, validatePlan, runPlan, renderPlan, resultSnapshot, makeOperationId, MAX_ACTIONS, ACTIONS};
