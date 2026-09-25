'use strict';

const { WORKER_INSPECTION_ACTIONS } = require('../../lib/worker-inspection-contract');
const INSPECTION_ACTIONS = Object.freeze({
  get_homelab_status: 'homelab_status',
  get_agent_activity: 'inspect_agent_activity',
  get_latest_agent_session_message: 'inspect_agent_session_history',
  continue_agent_session_history: 'inspect_agent_session_history',
});

// Availability is not authority. These flags may narrow the voice interface;
// the controller, executor and worker still authorize every actual operation.
const UNAVAILABLE = Object.freeze({
  controllerAvailable: false,
  workerInspectionAvailable: false,
  managedExecutionAvailable: false,
  reasonCode: 'CONTROLLER_CAPABILITIES_UNAVAILABLE',
});

const TOOL_CAPABILITIES = Object.freeze({
  send_agent_message: 'managed',
  start_agent_task: 'managed',
  handoff_agent_session: 'managed',
  adopt_tmux_context: 'managed_and_worker',
  get_homelab_status: 'worker',
  list_directory: 'worker',
  read_text_file: 'worker',
  find_files: 'worker',
  git_status: 'worker',
  list_tmux_sessions: 'worker',
  inspect_tmux_pane: 'worker',
  inspect_agent_session_history: 'worker',
  get_latest_agent_session_message: 'worker',
  get_agent_activity: 'worker',
  continue_agent_session_history: 'worker',
  get_agent_task: 'local',
  list_agent_tasks: 'local',
  list_agent_sessions: 'local',
  get_voice_history: 'local',
  get_voice_usage: 'local',
  list_preferences: 'local',
  remember_preference: 'local',
  forget_preference: 'local',
  get_weather: 'local',
  end_call: 'local',
  // Voice cancellation only explains the independent star control.
  cancel_agent_task: 'local',
  list_runtime_sessions: 'composite',
  describe_runtime: 'composite',
  // No advertised readiness flag can promote these production-disabled paths.
  send_agent_session_message: 'disabled',
  start_privileged_action: 'disabled',
});

function toolCapability(name) {
  return Object.hasOwn(TOOL_CAPABILITIES, name) ? TOOL_CAPABILITIES[name] : 'disabled';
}

function isToolAvailable(name, capabilities = UNAVAILABLE) {
  const controller = capabilities?.controllerAvailable === true;
  const worker = controller && capabilities?.workerInspectionAvailable === true;
  const managed = controller && capabilities?.managedExecutionAvailable === true;
  switch (toolCapability(name)) {
    case 'local':
    case 'composite': return true;
    case 'worker': return worker && WORKER_INSPECTION_ACTIONS.includes(
      Object.hasOwn(INSPECTION_ACTIONS, name) ? INSPECTION_ACTIONS[name] : name);
    case 'managed': return managed;
    case 'managed_and_worker': return managed && worker;
    default: return false;
  }
}

function unavailableResult(name, capabilities = UNAVAILABLE) {
  const disabled = toolCapability(name) === 'disabled';
  const unsupported = toolCapability(name) === 'worker' && !isToolAvailable(name, {
    controllerAvailable: true, workerInspectionAvailable: true,
  });
  const locked = capabilities?.reasonCode === 'VOICE_EXECUTION_LOCKED';
  let code = 'CONTROLLER_CAPABILITIES_UNAVAILABLE';
  let message = 'The isolated controller capability is unavailable. Local voice history and saved session records remain available.';
  if (disabled) {
    code = 'PHONE_AUTHORITY_UNAVAILABLE';
    message = 'Production phone authority does not permit this operation.';
  } else if (unsupported) {
    code = 'WORKER_INSPECTION_UNSUPPORTED';
    message = 'The isolated worker does not export this inspection. It cannot inspect owner provider history or host/cluster state.';
  } else if (locked) {
    code = 'VOICE_EXECUTION_LOCKED';
    message = 'Agent work is emergency-locked. Local voice history and saved session records remain available.';
  }
  return {
    success: false,
    available: false,
    code,
    message,
  };
}

function capabilitiesFromHealth(operator, executor) {
  // Only authenticated, scope-specific health responses count. Public /health
  // or a process being present is never sufficient. Unknown/legacy shapes fail
  // closed, as does a controller with the retired phone signer still installed.
  const safe = operator?.service === 'claude-api-server' &&
    operator?.phoneAuthority?.mode === 'read_only' &&
    operator?.phoneAuthority?.status === 'disabled_pending_independent_pbx_attester' &&
    operator?.approvalCapabilities?.verifierConfigured === false &&
    operator?.privilegedActions?.enabled === false &&
    operator?.privilegedActions?.proxyConfigured === false &&
    operator?.privilegedActions?.authConfigured === false &&
    operator?.authentication?.allActiveScopesConfiguredAndDistinct === true &&
    operator?.agentWorker?.enabled === true &&
    operator?.agentWorker?.hardened === true &&
    operator?.agentWorker?.legacySameUidEnabled === false &&
    operator?.workerSessionBroker?.enabled === true &&
    operator?.stateStorage?.enforced === true &&
    operator?.stateStorage?.admitted === true;
  if (!safe) return UNAVAILABLE;
  const locked = operator?.voiceExecution?.locked === true || operator?.executor?.panic?.locked === true;
  const worker = !locked && operator?.ready === true && operator?.status === 'ok' &&
    operator?.voiceExecution?.locked === false && operator?.executor?.panic?.locked === false &&
    operator?.workerSessionBroker?.ready === true;
  const managed = worker && executor?.service === 'claude-api-server' &&
    executor?.scope === 'executor' && executor?.ready === true && executor?.status === 'ready';
  return Object.freeze({
    controllerAvailable: true,
    workerInspectionAvailable: worker,
    managedExecutionAvailable: managed,
    reasonCode: locked ? 'VOICE_EXECUTION_LOCKED' : (managed ? null : UNAVAILABLE.reasonCode),
  });
}

async function readControllerCapabilities(agentBridge) {
  if (typeof agentBridge?.getRuntimeCapabilities !== 'function') return UNAVAILABLE;
  try {
    const value = await agentBridge.getRuntimeCapabilities();
    if (!value || value.controllerAvailable !== true) return UNAVAILABLE;
    // Own immutable data only. Never retain a bridge response as a live alias.
    return Object.freeze({
      controllerAvailable: true,
      workerInspectionAvailable: value.workerInspectionAvailable === true,
      managedExecutionAvailable: value.managedExecutionAvailable === true,
      reasonCode: value.reasonCode === 'VOICE_EXECUTION_LOCKED' ? value.reasonCode
        : (value.managedExecutionAvailable === true ? null : UNAVAILABLE.reasonCode),
    });
  } catch {
    return UNAVAILABLE;
  }
}

module.exports = {
  UNAVAILABLE, TOOL_CAPABILITIES, capabilitiesFromHealth, isToolAvailable,
  readControllerCapabilities, toolCapability, unavailableResult,
};
