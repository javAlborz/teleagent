#!/usr/bin/python3 -I
"""Inert hosted-VM kernel probe. No build, release or production authority."""
import ctypes
import errno
import json
import os
from pathlib import Path
import re
import resource
import select
import signal
import stat
import subprocess
import sys
import time
import uuid

CAPS = {'memory.max': '536870912', 'memory.swap.max': '0',
        'pids.max': '128', 'cpu.max': '100000 100000'}
PARENT_CAPS = {'memory.max': '805306368', 'memory.swap.max': '0',
               'pids.max': '256', 'cpu.max': '200000 100000'}
CHILD_CAPS = {
    'control': {'memory.max': '67108864', 'memory.swap.max': '0',
                'pids.max': '16', 'cpu.max': '25000 100000'},
    'engine': {'memory.max': '134217728', 'memory.swap.max': '0',
               'pids.max': '64', 'cpu.max': '50000 100000'},
    'workload': CAPS,
}
NAMESPACES = ('mnt', 'net', 'ipc', 'uts', 'pid', 'cgroup')
NEWPID = 0x20000000
OTHER_NAMESPACES = 0x00020000 | 0x40000000 | 0x08000000 | 0x04000000 | 0x02000000
MS_RDONLY, MS_NOSUID, MS_NODEV, MS_NOEXEC = 1, 2, 4, 8
MS_REMOUNT, MS_BIND, MS_REC, MS_PRIVATE = 32, 4096, 16384, 1 << 18
LIBC = ctypes.CDLL(None, use_errno=True)
QUOTA_IMAGE_BYTES = 32 * 1024 * 1024


class Refused(RuntimeError):
    pass


def need(condition, message):
    if not condition:
        raise Refused(message)


def syscall(name, *args):
    result = getattr(LIBC, name)(*args)
    if result == -1:
        raise OSError(ctypes.get_errno(), name)
    return result


def read_fd(fd, maximum=16384):
    parts, count = [], 0
    while True:
        data = os.read(fd, min(4096, maximum + 1 - count))
        if not data:
            return b''.join(parts).decode('ascii')
        count += len(data)
        need(count <= maximum, 'bounded read overflow')
        parts.append(data)


def read_at(directory, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
    try:
        return read_fd(fd)
    finally:
        os.close(fd)


def write_at(directory, name, value):
    need(name in {*CAPS, 'cgroup.procs', 'cgroup.kill'}, 'unexpected cgroup write')
    fd = os.open(name, os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
    try:
        data = (value + '\n').encode('ascii')
        need(os.write(fd, data) == len(data), 'short cgroup write')
    finally:
        os.close(fd)


def namespaces():
    return {name: os.stat('/proc/self/ns/' + name).st_ino for name in NAMESPACES}


def no_ipv4_routes(lines):
    return not lines or (len(lines) == 1 and lines[0].startswith('Iface\tDestination\t'))


def guard(environment, hostname, uid, machine, argv):
    need(hostname.split('.')[0].lower() != 'hermes', 'this probe must never execute on Hermes')
    need(argv == ['--run-hosted'] and uid == 0 and machine == 'x86_64', 'root x86_64 hosted invocation required')
    expected = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
                'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux'}
    need(set(environment) == {*expected, 'CI_PROBE_REVISION'} and
         all(environment.get(key) == value for key, value in expected.items()) and
         re.fullmatch('[a-f0-9]{40}', environment['CI_PROBE_REVISION']), 'exact clean hosted environment required')


def cgroup_mount(text):
    matches = [line.split() for line in text.splitlines() if len(line.split()) > 6 and line.split()[4] == '/sys/fs/cgroup']
    need(len(matches) == 1, 'single cgroup mount required')
    row = matches[0]
    separator = row.index('-')
    need(row[3] == '/' and row[separator + 1] == 'cgroup2' and 'rw' in row[5].split(','),
         'writable complete cgroup2 root required')


def identity(fd):
    value = os.fstat(fd)
    need(stat.S_ISDIR(value.st_mode) and value.st_uid == 0, 'root-owned retained directory required')
    return value.st_dev, value.st_ino


def still_owned(parent, name, fd):
    need(re.fullmatch(r'teleagent-ci-kernel-[a-f0-9]{32}', name), 'invalid owned directory name')
    other = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    try:
        need(identity(other) == identity(fd), 'owned directory identity changed')
    finally:
        os.close(other)


def still_owned_child(parent, name, fd):
    need(name in CHILD_CAPS, 'invalid owned child cgroup name')
    other = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                    dir_fd=parent)
    try:
        need(identity(other) == identity(fd), 'owned child cgroup identity changed')
    finally:
        os.close(other)


def enable_owned_subtree(fd):
    """Delegate only the three already available controllers on an empty owned parent."""
    need({'cpu', 'memory', 'pids'} <= set(read_at(fd, 'cgroup.controllers').split()) and
         not read_at(fd, 'cgroup.procs').strip(), 'owned parent cannot delegate controllers')
    control = os.open('cgroup.subtree_control', os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                      dir_fd=fd)
    try:
        data = b'+cpu +memory +pids\n'
        need(os.write(control, data) == len(data), 'short owned subtree control write')
    finally:
        os.close(control)
    need({'cpu', 'memory', 'pids'} <= set(read_at(fd, 'cgroup.subtree_control').split()),
         'owned subtree controllers did not enable')


def mount(source, target, kind=None, flags=0, data=None):
    encode = lambda value: value.encode('ascii') if value is not None else None
    syscall('mount', encode(source), encode(target), encode(kind), ctypes.c_ulong(flags), encode(data))


class Filter(ctypes.Structure):
    _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte), ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint)]


class Program(ctypes.Structure):
    _fields_ = [('len', ctypes.c_ushort), ('filter', ctypes.POINTER(Filter))]


def seccomp_program():
    # Inert primitive test ONLY: wrong architecture kills; getppid returns EPERM.
    # Other calls are permitted. This is deliberately not a confinement policy.
    return [(0x20, 0, 0, 4), (0x15, 1, 0, 0xc000003e), (0x06, 0, 0, 0x80000000),
            (0x20, 0, 0, 0), (0x15, 0, 1, 110), (0x06, 0, 0, 0x00050000 | errno.EPERM),
            (0x06, 0, 0, 0x7fff0000)]


def install_seccomp():
    rows = seccomp_program()
    filters = (Filter * len(rows))(*(Filter(*row) for row in rows))
    program = Program(len(rows), filters)
    syscall('prctl', 38, 1, 0, 0, 0)  # PR_SET_NO_NEW_PRIVS
    syscall('prctl', 22, 2, ctypes.byref(program), 0, 0)  # PR_SET_SECCOMP/FILTER
    ctypes.set_errno(0)
    result = LIBC.syscall(110)  # x86_64 getppid, without libc caching
    need(result == -1 and ctypes.get_errno() == errno.EPERM, 'seccomp denial was not enforced')


def drop_identity(last_cap):
    syscall('prctl', 47, 4, 0, 0, 0)  # clear ambient capabilities
    for cap in range(last_cap + 1):
        syscall('prctl', 24, cap, 0, 0, 0)  # drop bounding capability
    syscall('prctl', 8, 0, 0, 0, 0)  # no keepcaps
    os.setgroups([])
    os.setresgid(10001, 10001, 10001)
    os.setresuid(10001, 10001, 10001)
    header = (ctypes.c_uint32 * 2)(0x20080522, 0)
    data = (ctypes.c_uint32 * 6)()
    syscall('capset', ctypes.byref(header), ctypes.byref(data))


def expect_readonly(path):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError as error:
        need(error.errno == errno.EROFS, 'readonly proof returned a different error')
    else:
        os.close(fd)
        raise Refused('readonly mount allowed a new file')


def probe_overlay(root):
    """Exercise only an inert overlay copy-up on the child's private tmpfs."""
    base = root + '/overlay'
    os.mkdir(base, 0o700)
    for name in ('lower', 'upper', 'work', 'merged'):
        os.mkdir(base + '/' + name, 0o700)
    lower = base + '/lower/probe'
    upper = base + '/upper/probe'
    merged = base + '/merged/probe'
    with open(lower, 'xb') as stream:
        stream.write(b'lower\n')
    mount('overlay', base + '/merged', 'overlay', MS_NOSUID | MS_NODEV | MS_NOEXEC,
          'lowerdir=' + base + '/lower,upperdir=' + base + '/upper,workdir=' + base + '/work')
    try:
        need(Path(merged).read_bytes() == b'lower\n', 'overlay lower read differs')
        with open(merged, 'wb') as stream:
            stream.write(b'upper\n')
        need(Path(merged).read_bytes() == b'upper\n' and
             Path(lower).read_bytes() == b'lower\n' and
             Path(upper).read_bytes() == b'upper\n', 'overlay copy-up differs')
    finally:
        syscall('umount2', (base + '/merged').encode('ascii'), 0)
    need(os.stat(base + '/merged').st_dev == os.stat(base).st_dev,
         'overlay mount remains after private unmount')


def fixed_tool(argv, timeout=5):
    """Run only an explicit stock hosted-VM tool under the sterile probe env."""
    need(argv and argv[0] in ('/usr/sbin/mkfs.ext4', '/usr/bin/mount',
                                  '/usr/bin/umount'),
         'unexpected hosted storage tool')
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout, check=False,
                            cwd='/',
                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'})
    need(len(result.stdout) <= 4096 and len(result.stderr) <= 4096 and result.returncode == 0,
         'hosted storage tool refused: ' + argv[0].rsplit('/', 1)[-1])
    return result.stdout


def loop_backing_present(image, sysroot='/sys/block'):
    """Read kernel loop backing identities without forking after PID 1 exits."""
    root_fd = os.open(sysroot, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        with os.scandir(root_fd) as entries:
            names = [entry.name for entry in entries if re.fullmatch(r'loop[0-9]{1,4}', entry.name)]
        need(len(names) <= 256, 'loop device inventory exceeds bound')
        for name in names:
            device_fd = member_fd = backing_fd = None
            try:
                device_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC, dir_fd=root_fd)
                member_fd = os.open('loop', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                    dir_fd=device_fd)
                backing_fd = os.open('backing_file', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                     dir_fd=member_fd)
                data = os.read(backing_fd, 4097)
                need(len(data) <= 4096, 'loop backing identity exceeds bound')
                if data.rstrip(b'\n') == image.encode('ascii'):
                    return True
            except FileNotFoundError:
                # Autoclear can remove a loop's sysfs members during this scan.
                pass
            finally:
                for fd in (backing_fd, member_fd, device_fd):
                    if fd is not None:
                        os.close(fd)
        return False
    finally:
        os.close(root_fd)


def probe_bounded_disk(root, image):
    """Exercise byte and inode exhaustion on one owned loopback ext4 image."""
    mountpoint = root + '/quota'
    os.mkdir(mountpoint, 0o700)
    fixed_tool(['/usr/sbin/mkfs.ext4', '-q', '-F', '-m', '0', '-N', '128', image])
    fixed_tool(['/usr/bin/mount', '--no-mtab', '-t', 'ext4', '-o',
                'loop,nosuid,nodev,noexec', image, mountpoint])
    try:
        need(os.stat(mountpoint).st_dev != os.stat(root).st_dev,
             'bounded disk did not mount on a separate filesystem')
        before = os.statvfs(mountpoint)
        need(0 < before.f_blocks * before.f_frsize <= QUOTA_IMAGE_BYTES and
             0 < before.f_files <= 256, 'bounded disk byte/inode geometry differs')
        datafile = mountpoint + '/bytes'
        block = b'B' * (1024 * 1024)
        exhausted, written = False, 0
        fd = os.open(datafile, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
        try:
            for _ in range(64):
                try:
                    written += os.write(fd, block)
                    os.fsync(fd)
                except OSError as error:
                    if error.errno != errno.ENOSPC:
                        raise
                    exhausted = True
                    break
        finally:
            os.close(fd)
        need(exhausted and written <= QUOTA_IMAGE_BYTES,
             'bounded disk did not enforce its byte limit')
        os.unlink(datafile)
        names = []
        for index in range(256):
            filename = mountpoint + '/inode-' + str(index)
            try:
                fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
            except OSError as error:
                if error.errno != errno.ENOSPC:
                    raise
                break
            os.close(fd)
            names.append(filename)
        else:
            raise Refused('bounded disk did not enforce its inode limit')
        need(0 < len(names) < 256, 'bounded disk inode count differs')
        for filename in names:
            os.unlink(filename)
        return {'privateLoopExt4ByteLimit': True, 'privateLoopExt4InodeLimit': True,
                'imageBytes': QUOTA_IMAGE_BYTES, 'filesystemBytes': before.f_blocks * before.f_frsize,
                'filesystemInodes': before.f_files, 'bytesWrittenBeforeENOSPC': written,
                'filesCreatedBeforeENOSPC': len(names)}
    finally:
        fixed_tool(['/usr/bin/umount', '--no-mtab', '--detach-loop', mountpoint])
        need(os.stat(mountpoint).st_dev == os.stat(root).st_dev,
             'bounded disk mount remains after private unmount')


def child_probe(root, image, host_namespaces, last_cap, parent_pidfd):
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    need(os.getpid() == 1, 'fixture is not PID 1')
    syscall('unshare', OTHER_NAMESPACES)
    mount(None, '/', flags=MS_REC | MS_PRIVATE)
    mount('tmpfs', root, 'tmpfs', MS_NOSUID | MS_NODEV, 'size=1048576,mode=0755')
    probe_overlay(root)
    storage = probe_bounded_disk(root, image)
    for name in ('proc', 'sys', 'sys/fs', 'sys/fs/cgroup', 'input', 'readonly', 'rw'):
        os.mkdir(root + '/' + name, 0o755)
    os.chmod(root + '/input', 0o777)
    mount(root + '/input', root + '/readonly', flags=MS_BIND)
    mount(None, root + '/readonly', flags=MS_BIND | MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC)
    with open(root + '/input/control', 'xb') as stream:
        stream.write(b'readonly bind control\n')
    expect_readonly(root + '/readonly/blocked-before-root-remount')
    mount('tmpfs', root + '/rw', 'tmpfs', MS_NOSUID | MS_NODEV | MS_NOEXEC, 'size=65536,mode=0700,uid=10001,gid=10001')
    mount('proc', root + '/proc', 'proc', MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC)
    mount('none', root + '/sys/fs/cgroup', 'cgroup2', MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC)
    mount(None, root, flags=MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV)
    syscall('sethostname', b'ci-inert-probe', len('ci-inert-probe'))
    os.chroot(root)
    os.chdir('/')
    actual_namespaces = namespaces()
    need(all(actual_namespaces[key] != host_namespaces[key] for key in NAMESPACES), 'namespace identity was inherited')
    need(Path('/proc/self/cgroup').read_text() == '0::/\n', 'cgroup view is not own leaf root')
    cg = os.open('/sys/fs/cgroup', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        actual_caps = {key: read_at(cg, key).strip() for key in CAPS}
        need(actual_caps == CAPS and read_at(cg, 'cgroup.procs').split() == ['1'], 'leaf limits or process set differ')
    finally:
        os.close(cg)
    need(sorted(name for name in os.listdir('/proc') if name.isdigit()) == ['1'], 'extra PID visible in private proc')
    interfaces = [line.split(':')[0].strip() for line in Path('/proc/net/dev').read_text().splitlines()[2:]]
    route_lines = Path('/proc/net/route').read_text().splitlines()
    need(interfaces == ['lo'] and no_ipv4_routes(route_lines),
         'network namespace links/routes differ: interfaces=' + str(len(interfaces)) +
         ', loopback=' + str('lo' in interfaces) + ', routeLines=' + str(len(route_lines)))
    expect_readonly('/readonly/blocked-root')
    drop_identity(last_cap)
    # Credential changes clear PDEATHSIG. Re-arm and check the retained parent
    # handle, since getppid() is 0 across this PID-namespace boundary.
    syscall('prctl', 1, signal.SIGKILL, 0, 0, 0)
    need(select.select([parent_pidfd], [], [], 0)[0] == [], 'coordinator died during identity drop')
    install_seccomp()
    status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
    need(all(int(status[key].strip(), 16) == 0 for key in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb')),
         'capabilities remain after drop')
    need(status['NoNewPrivs'].strip() == '1' and status['Seccomp'].strip() == '2' and
         os.getresuid() == (10001,) * 3 and os.getresgid() == (10001,) * 3 and os.getgroups() == [],
         'identity/NNP/seccomp readback differs')
    expect_readonly('/readonly/blocked-user')
    expect_readonly('/input/blocked-rootfs')
    with open('/rw/inert', 'xb') as stream:
        stream.write(b'inert kernel fixture\n')
    need(Path('/rw/inert').read_bytes() == b'inert kernel fixture\n', 'private writable tmpfs failed')
    return {'passed': True, 'pid': 1, 'uid': 10001, 'gid': 10001, 'capabilitiesEmpty': True,
            'noNewPrivileges': True, 'seccompGetppidDenied': True, 'privateNamespaces': list(NAMESPACES),
            'leafLimits': actual_caps, 'soleLeafPid': 1, 'loopbackOnly': True,
            'readonlyRootAndBind': True, 'privateWritableTmpfs': True,
            'privateTmpfsOverlayCopyUp': True, **storage}


def interrupted(_signal, _frame):
    raise Refused('probe interrupted or timed out')


def run():
    guard(dict(os.environ), os.uname().nodename, os.geteuid(), os.uname().machine, sys.argv[1:])
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 ** 2,) * 2)
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    need(len(os.listdir('/proc/self/task')) == 1, 'single-thread coordinator required')
    cgroup_mount(Path('/proc/self/mountinfo').read_text())
    host_namespaces = namespaces()
    host_cgroup = Path('/proc/self/cgroup').read_text()
    host_hostname = os.uname().nodename
    last_cap = int(Path('/proc/sys/kernel/cap_last_cap').read_text())
    need(0 <= last_cap <= 63, 'unsupported capability range')
    cgroot = os.open('/sys/fs/cgroup', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    tmproot = os.open('/tmp', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    identity(cgroot)
    need({'cpu', 'memory', 'pids'} <= set(read_at(cgroot, 'cgroup.subtree_control').split()),
         'required controllers are not already enabled at cgroup root; no fallback')
    name = 'teleagent-ci-kernel-' + uuid.uuid4().hex
    image_name = name + '-quota.img'
    image_path = '/tmp/' + image_name
    cg = temporary = image_fd = pidfd = None
    children = {}
    created_children = []
    cg_created = temporary_created = image_created = False
    child = None
    descriptors = []
    result = {'purpose': 'inert-kernel-primitives-not-release-admission', 'revision': os.environ['CI_PROBE_REVISION'],
              'kernel': os.uname().release, 'releaseAuthority': False, 'buildExecuted': False,
              'providerExecuted': False, 'runtimeAccepted': False, 'cleanupVerified': False, 'passed': False}
    failure = None
    started = time.monotonic()
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    signal.alarm(55)
    try:
        os.mkdir(name, 0o700, dir_fd=cgroot)
        cg_created = True
        cg = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=cgroot)
        still_owned(cgroot, name, cg)
        for key, value in PARENT_CAPS.items():
            write_at(cg, key, value)
        need({key: read_at(cg, key).strip() for key in PARENT_CAPS} == PARENT_CAPS,
             'outer limit readback failed')
        enable_owned_subtree(cg)
        for child_name, limits in CHILD_CAPS.items():
            os.mkdir(child_name, 0o700, dir_fd=cg)
            created_children.append(child_name)
            child_fd = os.open(child_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                               dir_fd=cg)
            children[child_name] = child_fd
            still_owned_child(cg, child_name, child_fd)
            for key, value in limits.items():
                write_at(child_fd, key, value)
            need({key: read_at(child_fd, key).strip() for key in limits} == limits and
                 not read_at(child_fd, 'cgroup.procs').strip() and
                 not read_at(child_fd, 'cgroup.threads').strip(),
                 'child limit readback failed: ' + child_name)
        os.mkdir(name, 0o700, dir_fd=tmproot)
        temporary_created = True
        temporary = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=tmproot)
        still_owned(tmproot, name, temporary)
        image_fd = os.open(image_name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                           0o600, dir_fd=tmproot)
        image_created = True
        os.ftruncate(image_fd, QUOTA_IMAGE_BYTES)
        image_info = os.fstat(image_fd)
        need(stat.S_ISREG(image_info.st_mode) and image_info.st_uid == 0 and image_info.st_gid == 0 and
             stat.S_IMODE(image_info.st_mode) == 0o600 and image_info.st_nlink == 1 and
             image_info.st_size == QUOTA_IMAGE_BYTES, 'owned quota image metadata differs')
        ready_read, ready_write = os.pipe2(os.O_CLOEXEC)
        output_read, output_write = os.pipe2(os.O_CLOEXEC)
        descriptors.extend((ready_read, ready_write, output_read, output_write))
        parent_pidfd = os.pidfd_open(os.getpid(), 0)
        descriptors.append(parent_pidfd)
        # Only the next child enters the PID namespace. The coordinator stays
        # outside the leaf and original PID namespace: there is no intermediate.
        syscall('unshare', NEWPID)
        child = os.fork()
        if child == 0:
            try:
                for value in os.listdir('/proc/self/fd'):
                    fd = int(value)
                    if fd > 2 and fd not in (ready_read, output_write, parent_pidfd):
                        try:
                            os.close(fd)
                        except OSError as error:
                            if error.errno != errno.EBADF:
                                raise
                signal.alarm(40)
                syscall('prctl', 1, signal.SIGKILL, 0, 0, 0)
                need(select.select([parent_pidfd], [], [], 0)[0] == [], 'coordinator already died')
                need(os.read(ready_read, 1) == b'G', 'parent did not admit own child')
                os.close(ready_read)
                answer = child_probe('/tmp/' + name, image_path, host_namespaces, last_cap, parent_pidfd)
                data = (json.dumps(answer, sort_keys=True) + '\n').encode('ascii')
                need(len(data) < 8192 and os.write(output_write, data) == len(data), 'short child result')
                os._exit(0)
            except BaseException as error:
                try:
                    data = json.dumps({'passed': False, 'error': type(error).__name__ + ': ' + str(error)[:300]}).encode('ascii')
                    os.write(output_write, data)
                finally:
                    # Never fall through into coordinator cleanup with this
                    # child's intentionally closed inherited directory FDs.
                    os._exit(1)
        pidfd = os.pidfd_open(child, 0)
        os.close(ready_read)
        descriptors.remove(ready_read)
        os.close(output_write)
        descriptors.remove(output_write)
        still_owned(cgroot, name, cg)
        workload = children['workload']
        still_owned_child(cg, 'workload', workload)
        write_at(workload, 'cgroup.procs', str(child))
        need(read_at(workload, 'cgroup.procs').split() == [str(child)] and
             not read_at(cg, 'cgroup.procs').strip(), 'child did not enter exact owned leaf')
        need(os.write(ready_write, b'G') == 1, 'child admission pipe failed')
        os.close(ready_write)
        descriptors.remove(ready_write)
        readable, _, _ = select.select([pidfd], [], [], 45)
        need(readable == [pidfd], 'child exceeded bounded deadline')
        observed, status = os.waitpid(child, 0)
        need(observed == child, 'unexpected child reap')
        child = None
        answer = json.loads(read_fd(output_read, 8192))
        need(os.waitstatus_to_exitcode(status) == 0 and answer.get('passed') is True,
             'inert child refused: ' + str(answer.get('error', 'nonzero exit')))
        result['primitiveEvidence'] = answer
        result['leafMemoryPeakBytes'] = int(read_at(workload, 'memory.peak'))
        result['leafMemoryEvents'] = dict((key, int(value)) for key, value in
                                          (line.split() for line in read_at(workload, 'memory.events').splitlines()))
        need(all(value == 0 for value in result['leafMemoryEvents'].values()), 'unexpected probe memory events')
        result['ownedCgroupTree'] = {'outerLimits': PARENT_CAPS, 'childLimits': CHILD_CAPS,
                                     'controllers': ['cpu', 'memory', 'pids']}
        result['passed'] = True
    except Exception as error:
        failure = type(error).__name__ + ': ' + str(error)[:400]
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            # EOF releases a child still waiting at its admission barrier even
            # if pidfd_open failed. No signal ever uses a numeric PID.
            if 'ready_write' in locals() and ready_write in descriptors:
                os.close(ready_write)
                descriptors.remove(ready_write)
            if pidfd is not None:
                try:
                    signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if cg is not None:
                still_owned(cgroot, name, cg)
                write_at(cg, 'cgroup.kill', '1')
            if child is not None:
                deadline = time.monotonic() + 3
                while True:
                    observed, _status = os.waitpid(child, os.WNOHANG)
                    if observed == child:
                        break
                    need(time.monotonic() < deadline, 'child cleanup timeout')
                    time.sleep(0.02)
            need(not cg_created or cg is not None, 'created cgroup has no retained cleanup identity')
            need(not temporary_created or temporary is not None, 'created directory has no retained cleanup identity')
            need(not image_created or image_fd is not None, 'created quota image has no retained cleanup identity')
            if cg is not None:
                deadline = time.monotonic() + 3
                while 'populated 1' in read_at(cg, 'cgroup.events') and time.monotonic() < deadline:
                    time.sleep(0.02)
                need('populated 0' in read_at(cg, 'cgroup.events') and not read_at(cg, 'cgroup.procs').strip() and
                     not read_at(cg, 'cgroup.threads').strip(), 'owned cgroup is not empty')
                need(set(created_children) == set(children), 'created child lacks retained cleanup identity')
                for child_name in reversed(created_children):
                    child_fd = children[child_name]
                    still_owned_child(cg, child_name, child_fd)
                    need('populated 0' in read_at(child_fd, 'cgroup.events') and
                         not read_at(child_fd, 'cgroup.procs').strip() and
                         not read_at(child_fd, 'cgroup.threads').strip(),
                         'owned child cgroup is not empty: ' + child_name)
                    os.rmdir(child_name, dir_fd=cg)
                still_owned(cgroot, name, cg)
                os.rmdir(name, dir_fd=cgroot)
            if temporary is not None:
                still_owned(tmproot, name, temporary)
                need(os.listdir(temporary) == [], 'private mounts or unexpected temporary files remain')
                os.rmdir(name, dir_fd=tmproot)
            if image_fd is not None:
                retained = os.fstat(image_fd)
                after = os.stat(image_name, dir_fd=tmproot, follow_symlinks=False)
                need(stat.S_ISREG(retained.st_mode) and retained.st_uid == 0 and retained.st_gid == 0 and
                     stat.S_IMODE(retained.st_mode) == 0o600 and retained.st_nlink == 1 and
                     0 <= retained.st_size <= QUOTA_IMAGE_BYTES and
                     (after.st_dev, after.st_ino, after.st_uid, after.st_gid, after.st_mode,
                      after.st_nlink, after.st_size) ==
                     (retained.st_dev, retained.st_ino, retained.st_uid, retained.st_gid,
                      retained.st_mode, retained.st_nlink, retained.st_size),
                     'owned quota image changed before cleanup')
                need(not loop_backing_present(image_path),
                     'owned quota loop remains attached')
                os.unlink(image_name, dir_fd=tmproot)
            need(namespaces() == host_namespaces and Path('/proc/self/cgroup').read_text() == host_cgroup and
                 os.uname().nodename == host_hostname, 'coordinator namespace/cgroup/hostname changed')
            result['cleanupVerified'] = True
        except Exception as error:
            result['cleanupError'] = type(error).__name__ + ': ' + str(error)[:400]
            result['passed'] = False
        for fd in [*descriptors, pidfd, *children.values(), cg, temporary, image_fd, cgroot, tmproot]:
            if fd is not None:
                os.close(fd)
    result['elapsedSeconds'] = round(time.monotonic() - started, 6)
    if failure:
        result['error'] = failure
    print(json.dumps(result, sort_keys=True))
    return 0 if result['passed'] and result['cleanupVerified'] else 1


if __name__ == '__main__':
    try:
        raise SystemExit(run())
    except (Refused, OSError, ValueError) as error:
        print(json.dumps({'purpose': 'inert-kernel-primitives-not-release-admission', 'passed': False,
                          'releaseAuthority': False, 'error': type(error).__name__ + ': ' + str(error)[:400]}))
        raise SystemExit(1)
