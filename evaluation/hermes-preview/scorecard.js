'use strict';

function triState(values) {
  if (values.every((value) => value === true)) return 'pass';
  if (values.some((value) => value === false)) return 'fail';
  return 'unknown';
}

function knownGate(known, pass) {
  return known ? (pass ? 'pass' : 'fail') : 'unknown';
}

function item(key, label, status, observed) {
  return {
    key,
    label,
    status,
    observed,
  };
}

function buildScorecard(evidence, health) {
  const panicStatus = triState([
    health.realtime.reachable,
    health.realtime.healthy,
    health.realtime.voiceExecutionLocked,
    health.realtime.voiceExecutionPersistent,
  ]);
  const realtimeStatus = triState([
    health.realtime.reachable,
    health.realtime.healthy,
    health.realtime.configured,
    health.realtime.stateHealthy,
    health.realtime.capacityHealthy,
  ]);
  const voiceStatus = triState([health.voiceApp.reachable, health.voiceApp.healthy]);
  const controllerStatus = triState([health.controller.reachable]);
  const sessionReliability = evidence.sessions.completionRatePercent;
  const evidenceAvailable = evidence.available === true;
  const observed = (value) => evidenceAvailable ? value : 'unavailable';
  const validAccounting = evidenceAvailable &&
    evidence.usage.validResponseRecords > 0 && evidence.usage.totalTokens > 0;
  const terminalSessions = evidenceAvailable
    ? evidence.sessions.closed + evidence.sessions.failed
    : null;
  const terminalSessionGate = evidenceAvailable && terminalSessions >= 5 &&
    evidence.sessions.total === terminalSessions;

  const checks = [
    item('panic_preserved', 'Persistent voice panic lock observed', panicStatus,
      panicStatus === 'pass' ? 'locked and persistent' : 'not proven'),
    item('evidence_available', 'Offline current-window evidence available',
      evidenceAvailable ? 'pass' : 'fail',
      evidenceAvailable ? 'available' : 'unavailable'),
    item('voice_health', 'Voice endpoint reachable and healthy', voiceStatus,
      voiceStatus === 'pass' ? 'healthy' : (voiceStatus === 'unknown' ? 'unknown' : 'not healthy')),
    item('realtime_health', 'Realtime state and durable-state capacity healthy', realtimeStatus,
      realtimeStatus === 'pass'
        ? 'healthy' : (realtimeStatus === 'unknown' ? 'unknown' : 'not healthy')),
    item('controller_reachable',
      'Controller endpoint responded (readiness intentionally false under panic)', controllerStatus,
      controllerStatus === 'pass'
        ? 'responded; readiness intentionally false under panic'
        : (controllerStatus === 'unknown' ? 'unknown' : 'unreachable')),
    item('sessions', 'At least 5 terminal current-window sessions and no open/unknown sessions',
      knownGate(evidenceAvailable, terminalSessionGate),
      evidenceAvailable ? `${terminalSessions} terminal / ${evidence.sessions.total} total` : 'unavailable'),
    item('repeat_use', 'Sessions on at least 3 current-window days',
      knownGate(evidenceAvailable, evidence.sessions.activeDays >= 3),
      observed(evidence.sessions.activeDays)),
    item('conversation_depth', 'At least 15 current-window user turns',
      knownGate(evidenceAvailable, evidence.turns.user >= 15), observed(evidence.turns.user)),
    item('session_reliability', 'At least 90% terminal-session completion',
      !evidenceAvailable || sessionReliability === null
        ? 'unknown' : (sessionReliability >= 90 ? 'pass' : 'fail'),
      !evidenceAvailable ? 'unavailable' :
        (sessionReliability === null ? 'not enough evidence' : `${sessionReliability}%`)),
    item('usage_recorded', 'Validated positive Realtime response accounting observed',
      knownGate(evidenceAvailable, validAccounting),
      evidenceAvailable ? evidence.usage.validResponseRecords : 'unavailable'),
  ];

  let decision = 'continue_bounded_hermes_evaluation';
  let headline = 'Continue the bounded Hermes evaluation';
  if (panicStatus !== 'pass') {
    decision = 'stop_and_restore_panic_lock';
    headline = 'Stop: restore the persistent panic lock';
  } else if (!evidenceAvailable) {
    decision = 'repair_evidence_lane';
    headline = 'Repair the evidence lane before evaluating';
  } else if (checks.every((check) => check.status === 'pass')) {
    decision = 'machine_evidence_threshold_met';
    headline = 'Machine evidence threshold met; manual review required';
  }

  return {
    decision,
    headline,
    passed: checks.filter((check) => check.status === 'pass').length,
    failed: checks.filter((check) => check.status === 'fail').length,
    unknown: checks.filter((check) => check.status === 'unknown').length,
    total: checks.length,
    manualReviewRequired: true,
    investmentAuthorized: false,
    productionAuthorized: false,
    checks,
    manualChecks: [
      'Voice latency feels acceptable over several real calls',
      'Interruption and barge-in behave predictably',
      'Answers are consistently useful for intended tasks',
      'Observed token use is affordable at expected frequency',
      'The experience meets the operator’s privacy expectations',
    ],
  };
}

module.exports = { buildScorecard, triState };
