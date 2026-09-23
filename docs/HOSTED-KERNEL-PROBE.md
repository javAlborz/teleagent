# Inert hosted kernel probe

The existing public pull-request validation workflow has a source candidate for
a small kernel probe before dependency installation. It uses the standard
`ubuntu-24.04` runner's installed `/usr/bin/python3` and libc. It downloads,
compiles and executes no provider, container engine or acquired dependency code.
The storage extension invokes only the runner's installed `mkfs.ext4`, `mount`
and `umount` on one fresh owned 32 MiB image.
No credentials, OIDC permission, private infrastructure configuration, artifact
publication or release admission is involved. Its output always records
`releaseAuthority=false`, `runtimeAccepted=false` and `buildExecuted=false`.

The workflow and fixture require independent source review before the parent
integrator pushes them. Local validation on Hermes is restricted to the synthetic
unit suite through `scripts/hermes-safe-test`; the actual probe explicitly refuses
the hostname Hermes. Do not invoke its hosted entry on Hermes or a persistent
server, including through a container or altered hostname.

## What a hosted run tests

The clean-environment sudo coordinator creates one exclusive empty outer cgroup at the
existing cgroup2 root and applies 768 MiB memory, zero swap, 256 tasks and two CPUs.
The `cpu`, `memory` and `pids` controllers must already be enabled at that root.
It enables those three controllers only within its own empty outer cgroup,
then creates separate child leaves for control (64 MiB/16 tasks/quarter CPU),
engine (128 MiB/64 tasks/half CPU), and workload
(512 MiB/128 tasks/one CPU). The children fit under the outer caps. The control
and engine leaves stay empty in this inert test; no BuildKit process runs.
It never writes an ancestor's controllers or limits, moves an existing host
process, creates a systemd unit, changes a host service/socket/sysctl, or uses a
fallback if those conditions fail. It creates one random exclusive temporary
directory and one exact root-owned image file under `/tmp`.

The coordinator creates a PID namespace for its next child only, forks once,
opens a pidfd and moves that unreaped owned child into the exact retained workload leaf.
A pipe holds the child until limit and membership readback passes. The coordinator
stays outside that leaf and in its original PID namespace. The child becomes PID 1,
then creates fresh mount, network, IPC, UTS and cgroup namespaces. It makes mount
propagation private before mounting anything.

The fixed inert fixture proves:

- all six namespace identities differ from the coordinator's;
- a new proc mount shows only PID 1, and the namespace-relative cgroup root shows
  exactly that PID and the requested finite limits;
- the network namespace has only loopback and no IPv4 routes;
- an owned bind rejects writes with EROFS while its source remains writable,
  then the private tmpfs root also becomes read-only;
- an inert overlay mount on that private tmpfs reads a lower file, copies a
  changed file into its upper directory, and unmounts before privilege drop;
- a private loopback ext4 mount on that image has at most 32 MiB and 256
  inodes, returns ENOSPC under both bounded byte and inode writes, and unmounts
  with loop detachment before privilege drop;
- a separate small writable tmpfs remains usable after dropping to UID/GID 10001;
- every capability set, including bounding and ambient, is empty, supplementary
  groups are empty, NNP is set and seccomp mode 2 is active;
- the tiny fixture filter actually returns EPERM for the x86_64 `getppid` syscall.

The filter permits other syscalls; it tests the seccomp primitive and is explicitly
**not a production confinement profile**. No acquired dependency or arbitrary command runs
inside it. The fixture does not exercise an OCI runtime, device BPF, native
compilation, BuildKit's mount shape, final image export or any provider.

## Lifetime and cleanup

The coordinator retains directory identities, the direct-child pidfd and its own
pidfd inherited by the child for parent-lifetime polling. The child closes other extra descriptors,
arms parent-death SIGKILL, checks that retained parent handle, and repeats that
step after the credential drop clears the setting. Neither signaling nor cleanup
uses an unowned process ID or a broad process-name match.

The child has a 40-second wall deadline and ten CPU seconds. The coordinator has
a 55-second wall deadline, 256 MiB virtual-address bound and 128 descriptor bound.
It waits at most 45 seconds for the child. Cleanup signals the exact pidfd and
writes `cgroup.kill` only through the retained, revalidated owned outer cgroup.
It requires the child reaped, all three child leaves and the outer cgroup
unpopulated, all process/thread lists empty and the
temporary directory empty before nonrecursive removal. It also rechecks the
retained image inode, checks kernel loop backing identities without forking,
requires no loop association for its exact path, then
unlinks that one file. Cleanup waits are bounded;
ambiguous identity or leftover objects report failure, not successful cleanup.
The workflow has a two-minute outer step timeout. The disposable hosted VM is the
last boundary if the job is forcibly cancelled before cleanup can complete.

A passed result records kernel version, validation commit, primitive evidence,
leaf memory peak/events and cleanup status. It demonstrates those primitive
operations on **that runner generation**, not stable runner identity, release
authority, trusted source selection, complete build confinement or artifact
reproducibility. A failed probe keeps its exact unmet dependency visible and must
not disable host security settings or weaken any production gate.

The overlay check proves only this private tmpfs-backed mount and copy-up. The
loopback check proves finite byte/inode behavior on a disposable ext4 image,
using util-linux's automatic loop setup and detach behavior
([mount](https://github.com/util-linux/util-linux/blob/master/sys-utils/mount.8.adoc),
[umount](https://github.com/util-linux/util-linux/blob/master/sys-utils/umount.8.adoc))
and the kernel's `backing_file` sysfs attribute
([Linux loop driver](https://github.com/torvalds/linux/blob/master/drivers/block/loop.c)).
Neither proves BuildKit's overlay snapshotter on a larger dedicated bounded
disk, native package execution, or complete cleanup of an actual builder.

## Existing runner constraints

GitHub documents standard multi-CPU hosted Linux runners as fresh VMs with
passwordless sudo. Its Ubuntu 24.04 inventory currently lists Python 3.12.3 and
systemd 255; runner kernels and images change, so this probe reports the actual
kernel rather than treating the label as a kernel pin.
[GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[Ubuntu image inventory](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md).

The kernel's cgroup namespace is rooted at the caller's cgroup when created;
mounting cgroup2 inside that namespace provides the relative view. This is why
the child enters its leaf before creating the cgroup namespace. `cgroup.kill`
targets that cgroup's descendants and handles concurrent forks; this fixture
still proves emptiness before deletion. The NNP/seccomp checks follow the kernel
interfaces without changing any host AppArmor, user-namespace or sysctl policy.
[Cgroup v2 namespace and lifetime](https://docs.kernel.org/admin-guide/cgroup-v2.html),
[NNP interface](https://www.kernel.org/doc/html/latest/userspace-api/no_new_privs.html),
[seccomp filter interface](https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html).

Synthetic tests validate clean invocation and Hermes refusal, mount/controller
preconditions, bounded reads, owned-name and write-target refusal, exact EROFS
evidence and the small BPF program's decisions. They never perform a privileged
operation or claim actual hosted acceptance.
