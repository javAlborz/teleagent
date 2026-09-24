'use strict';

// One source of truth for what the current isolated worker actually exports.
// Provider-log history and host/cluster inspection belong to other boundaries;
// a healthy worker is not evidence that those legacy operations are available.
const WORKER_INSPECTION_ACTIONS = Object.freeze([
  'list_directory', 'read_text_file', 'find_files', 'git_status',
  'list_tmux_sessions', 'inspect_tmux_pane', 'inspect_agent_activity', 'describe_runtime',
]);

module.exports = { WORKER_INSPECTION_ACTIONS };
