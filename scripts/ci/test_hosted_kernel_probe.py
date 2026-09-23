#!/usr/bin/python3 -I
"""Synthetic guard/parser tests only; never create a namespace or cgroup."""
import errno
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).with_name('hosted-kernel-probe.py')
probe = types.ModuleType('hosted_kernel_probe')
exec(compile(SOURCE.read_bytes(), str(SOURCE), 'exec'), probe.__dict__)


def environment():
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'GITHUB_ACTIONS': 'true',
            'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux', 'CI_PROBE_REVISION': 'a' * 40}


class ProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.uname().nodename.split('.')[0].lower() == 'hermes':
            root = Path('/sys/fs/cgroup' + Path('/proc/self/cgroup').read_text().strip().split('::')[1])
            actual = {key: (root / key).read_text().strip() for key in probe.CAPS}
            if actual != probe.CAPS:
                raise RuntimeError('Hermes tests require the exact serial safe-test envelope')

    def test_hosted_guard_and_explicit_hermes_refusal(self):
        probe.guard(environment(), 'hosted-runner', 0, 'x86_64', ['--run-hosted'])
        for hostname, uid, machine, args in [('Hermes', 0, 'x86_64', ['--run-hosted']),
                                           ('hermes.example', 0, 'x86_64', ['--run-hosted']),
                                           ('runner', 1000, 'x86_64', ['--run-hosted']),
                                           ('runner', 0, 'aarch64', ['--run-hosted']),
                                           ('runner', 0, 'x86_64', []),
                                           ('runner', 0, 'x86_64', ['--run-hosted', '--path', '/'])]:
            with self.subTest(hostname=hostname, args=args), self.assertRaises(probe.Refused):
                probe.guard(environment(), hostname, uid, machine, args)

    def test_no_inherited_secret_path_or_locale_overrides(self):
        for key, value in [('HOME', '/root'), ('GITHUB_TOKEN', 'synthetic'), ('PATH', '/tmp:/usr/bin'),
                           ('RUNNER_ENVIRONMENT', 'self-hosted'), ('CI_PROBE_REVISION', 'z' * 40),
                           ('LD_PRELOAD', 'fixture'), ('LC_ALL', 'C')]:
            altered = environment()
            altered[key] = value
            with self.subTest(key=key), self.assertRaises(probe.Refused):
                probe.guard(altered, 'runner', 0, 'x86_64', ['--run-hosted'])

    def test_requires_complete_writable_cgroup2_mount(self):
        row = '30 20 0:29 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n'
        probe.cgroup_mount(row)
        for altered in [row + row, row.replace(' / /sys', ' /delegated /sys'),
                        row.replace('rw,nosuid', 'ro,nosuid'), row.replace('- cgroup2 ', '- cgroup '), '']:
            with self.assertRaises(probe.Refused):
                probe.cgroup_mount(altered)

    def test_cleanup_name_and_write_allowlist_refuse_before_syscall(self):
        for name in ('../system.slice', 'system.slice', 'teleagent-ci-kernel-' + 'A' * 32, '/tmp/probe'):
            with patch.object(probe.os, 'open') as opened, self.assertRaises(probe.Refused):
                probe.still_owned(9, name, 10)
            opened.assert_not_called()
        for name in ('../engine', 'other', 'teleagent-ci-kernel-' + 'a' * 32):
            with patch.object(probe.os, 'open') as opened, self.assertRaises(probe.Refused):
                probe.still_owned_child(9, name, 10)
            opened.assert_not_called()
        for name in ('cgroup.subtree_control', '../cgroup.procs', 'memory.high'):
            with patch.object(probe.os, 'open') as opened, self.assertRaises(probe.Refused):
                probe.write_at(9, name, '1')
            opened.assert_not_called()

    def test_nested_cgroup_limits_fit_and_parent_must_be_empty(self):
        for key in ('memory.max', 'pids.max'):
            self.assertLessEqual(sum(int(row[key]) for row in probe.CHILD_CAPS.values()),
                                 int(probe.PARENT_CAPS[key]))
        self.assertLessEqual(sum(int(row['cpu.max'].split()[0]) for row in probe.CHILD_CAPS.values()),
                             int(probe.PARENT_CAPS['cpu.max'].split()[0]))
        with patch.object(probe, 'read_at', side_effect=['cpu memory pids', '222\n']):
            with patch.object(probe.os, 'open') as opened, self.assertRaises(probe.Refused):
                probe.enable_owned_subtree(9)
            opened.assert_not_called()

    def test_retained_read_consumes_eof_and_refuses_overflow(self):
        for raw, maximum, succeeds in [(b'abc', 3, True), (b'abcd', 3, False), (b'', 3, True)]:
            read, write = os.pipe()
            try:
                os.write(write, raw)
                os.close(write)
                write = None
                if succeeds:
                    self.assertEqual(probe.read_fd(read, maximum), raw.decode())
                else:
                    with self.assertRaises(probe.Refused):
                        probe.read_fd(read, maximum)
            finally:
                os.close(read)
                if write is not None:
                    os.close(write)

    def test_seccomp_fixture_is_only_an_arch_and_one_syscall_primitive(self):
        def evaluate(architecture, syscall_number):
            instructions, index, accumulator = probe.seccomp_program(), 0, 0
            while index < len(instructions):
                opcode, yes, no, value = instructions[index]
                if opcode == 0x20:
                    accumulator = architecture if value == 4 else syscall_number
                elif opcode == 0x15:
                    index += yes if accumulator == value else no
                elif opcode == 0x06:
                    return value
                else:
                    self.fail('unrecognized synthetic BPF opcode')
                index += 1
            self.fail('no filter decision')
        self.assertEqual(evaluate(0x40000003, 110), 0x80000000)
        self.assertEqual(evaluate(0xc000003e, 110), 0x50000 | errno.EPERM)
        self.assertEqual(evaluate(0xc000003e, 39), 0x7fff0000)
        self.assertEqual(evaluate(0xc000003e, 165), 0x7fff0000)  # not a production syscall policy

    def test_readonly_requires_erofs_instead_of_unrelated_permissions(self):
        with patch.object(probe.os, 'open', side_effect=OSError(errno.EROFS, 'read-only')):
            probe.expect_readonly('/fixture')
        for code in (errno.EACCES, errno.EPERM, errno.ENOENT):
            with patch.object(probe.os, 'open', side_effect=OSError(code, 'different denial')):
                with self.assertRaises(probe.Refused):
                    probe.expect_readonly('/fixture')

    def test_storage_probe_refuses_unlisted_executable_before_spawn(self):
        with patch.object(probe.subprocess, 'run') as spawned:
            with self.assertRaises(probe.Refused):
                probe.fixed_tool(['/bin/sh', '-c', 'true'])
            spawned.assert_not_called()

    def test_loop_cleanup_reads_only_exact_kernel_backing_path(self):
        with tempfile.TemporaryDirectory(prefix='teleagent-loop-sysfs-fixture-') as temporary:
            backing = Path(temporary) / 'loop7/loop/backing_file'
            backing.parent.mkdir(parents=True)
            backing.write_bytes(b'/tmp/other-quota.img\n')
            self.assertFalse(probe.loop_backing_present('/tmp/owned-quota.img', temporary))
            backing.write_bytes(b'/tmp/owned-quota.img\n')
            self.assertTrue(probe.loop_backing_present('/tmp/owned-quota.img', temporary))

    def test_empty_or_header_only_ipv4_route_table(self):
        header = 'Iface\tDestination\tGateway\tFlags'
        self.assertTrue(probe.no_ipv4_routes([]))
        self.assertTrue(probe.no_ipv4_routes([header]))
        self.assertFalse(probe.no_ipv4_routes(['lo\t00000000\t00000000']))
        self.assertFalse(probe.no_ipv4_routes([header, 'lo\t00000000\t00000000']))


if __name__ == '__main__':
    unittest.main()
