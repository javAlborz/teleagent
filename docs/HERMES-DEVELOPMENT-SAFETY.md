# Hermes development safety

Teleagent production processes currently load code or state from
`/home/alborz/phone/teleagent`. Do not edit, build, install dependencies, or run
test suites from that checkout while the legacy stack exists.

Architecture work belongs in a durable independent copy under
`/home/alborz/dev2`. The copy must exclude ignored credentials, live state,
audio, generated media, dependency trees, and container data. A Git status
digest should match the source working tree immediately after the copy is made.

Every validation command on Hermes runs through:

```console
scripts/hermes-safe-test <command> [args...]
```

The wrapper first takes one per-user lock shared by every Teleagent worktree,
so separate agents cannot overlap otherwise bounded validations. It then
creates one canonical `hermes-dev-test` scope with a one-core CPU quota,
1536 MiB memory ceiling, 128 MiB swap ceiling, 192-task ceiling, idle I/O
priority, low CPU scheduling priority, serial Node test-file execution, and a
hard timeout of five minutes. `HERMES_SAFE_TEST_TIMEOUT_SECONDS` may lower or
raise the timeout only within 1–900 seconds.

Run one validation command at a time. Start with syntax and the smallest
targeted test file. Expand only after host load, CPU pressure, I/O pressure, and
the prior scope's exit status are healthy. Never activate source-only systemd,
Docker, SIP, firewall, provider, worker, or broker deployment paths as part of a
source test.

The production execution lock stays engaged until the architecture promotion
gates pass. Test completion is not authorization to start or unlock production.
