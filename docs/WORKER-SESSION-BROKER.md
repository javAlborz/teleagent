# Worker execution and session boundary

Teleagent never runs Claude or Codex under the controller identity. The
controller owns scoped API bearers, approval verification state, executor
state, and the privileged-action proxy. Every provider launch therefore needs
all of these independently enforced host boundaries:

1. `teleagent-control` talks only to provider-specific supervisors over
   `/run/teleagent-provider-launch/{claude,codex}.sock`.
2. The supervisors run as `teleagent-{claude,codex}-supervisor`, admit one
   launch at a time, and ask the fixed root boundary to create one transient
   systemd cgroup. They hold no provider credential.
3. Model/tool processes run as distinct
   `teleagent-{claude,codex}-worker` identities whose account homes are fixed
   beneath `/nonexistent`; there is no persistent provider home. Each launch
   gets a private tmpfs HOME, private network namespace, private `/run`, bounded
   resources, and no capabilities. Read-only launches mount the workspace
   read-only.
4. A different `teleagent-{claude,codex}-shim` identity is the only process in
   that namespace allowed to reach its matching provider-egress Unix socket.
   The model sees only a fixed nonsecret local API-key sentinel. A random
   launch capability remains shim-only.
5. `teleagent-{claude,codex}-egress` alone reads the real provider credential.
   It accepts only the pinned provider host, model, routes and request shapes,
   enforces conservative durable request/token budgets, strips untrusted auth,
   and revokes every launch capability on restart or shutdown.

Both provider worker identities are mandatory:

```dotenv
AGENT_WORKER_USER=
AGENT_CLAUDE_WORKER_USER=teleagent-claude-worker
AGENT_CODEX_WORKER_USER=teleagent-codex-worker
AGENT_CLAUDE_WORKER_HOME=/nonexistent/teleagent-claude-worker
AGENT_CODEX_WORKER_HOME=/nonexistent/teleagent-codex-worker
AGENT_PROVIDER_SUPERVISOR_CLIENT_PATH=/usr/local/libexec/teleagent-provider-supervisor-client
AGENT_WORKER_WORKSPACE_ROOT=/srv/teleagent-agent-workspaces
AGENT_WORKER_DEFAULT_WORKSPACE=/srv/teleagent-agent-workspaces/phone
```

`AGENT_WORKER_USER` is obsolete and a nonempty value is rejected. Missing or
unhealthy provider/session boundaries leave the HTTP process available only
for authenticated diagnostics. General `/ask`, phone execution, durable task
claims, provider launch, workspace inspection, and tmux delivery fail closed.
`AGENT_WORKER_LEGACY_SAME_UID_ENABLED=true` is only a non-ready rollback
indicator; it never authorizes a controller-UID provider child.

## Session-broker RPC surface

`teleagent-worker-session.socket` is systemd socket activated at
`/run/teleagent-worker-session/broker.sock`. Its filesystem owner is
`teleagent-session-broker`, its client group is exactly `teleagent-control`, and
its mode is 0660. The service, SQLite operation database, pane-status directory,
and tmux server/socket are owned by `teleagent-session-broker`; neither provider
worker can traverse or connect to them.

The broker exposes only:

- bounded realpath-checked workspace and Git reads below
  `/srv/teleagent-agent-workspaces`;
- its dedicated mode-0600 tmux socket
  `/run/teleagent-worker-session/tmux.sock`;
- sanitized provider-session history projected into broker-readable stores;
- exact prepare, durable operation-ID commit, interrupt, marker reconciliation,
  and a provider-accepted pane-creation handshake.

Docker, Kubernetes, private-network, root-filesystem, owner-home, controller,
and privileged-broker reads are not session-broker capabilities. Those require
a typed privileged-action plan and focused phone approval.

The operation store uses SQLite WAL plus `synchronous=FULL`. A delivery boundary
is persisted before tmux input; ambiguous delivery is reconciled and never
blindly resent. Restarted post-boundary operations remain outcome-unknown until
the exact pane/session marker and final provider response prove completion.

## Session parity and deliberate limits

Only sessions created on the broker-owned tmux socket are visible. Historical
owner/alborz sessions such as `main:phone` are intentionally invisible. The
broker rejects Codex interactive creation because pinned Codex 0.149.1 cannot
resume interactively while also ignoring persistent user/project configuration.
Managed Luna, Terra, and Sol launches remain available through clean
`codex exec` boundaries. Claude pane creation is serialized and becomes active
only after the supervisor reports the exact launch accepted.

This is not unrestricted Claude Code/Codex terminal parity. Provider workers
cannot directly reach the homelab or internet; all homelab mutations go through
the audited privileged broker, and provider API traffic goes only through the
matching bounded egress service.

## Source-only activation contract

The tracked units, sockets, sysusers, tmpfiles, sudoers, policies, empty runtime
configuration, and verification script under `deploy/worker-session/` are
dormant. Activation requires a root review, provider-specific credentials with
project-side billing limits plus local conservative request/reserved-token
allowances, `/etc/teleagent/worker-session/ENABLE`, and a clean
run of `verify-worker-session-boundary`. The verifier exercises the real split
UIDs, socket/DB/tmux DAC denials, clean-config canaries, private-runtime socket
mask, provider egress, and zero-capability model runtime. Do not add provider
workers to `teleagent-control` or `teleagent-provider-launch`, expose the root
broker, copy provider credentials into worker homes, or make owner tmux sockets
visible.

The local allowance is not actual token usage, dollar spend, or remaining
OpenAI/Anthropic project balance. Provider billing dashboards remain
authoritative; Teleagent reports only bounded local request and conservative
reserved-token counters.
