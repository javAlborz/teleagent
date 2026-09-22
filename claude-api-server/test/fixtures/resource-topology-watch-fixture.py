"""Disposable ordinary-directory tests only; never touches a live cgroup."""
import ctypes
import errno
import os
from pathlib import Path
import runpy
import signal
import struct
import subprocess
import sys
import tempfile
import time
import traceback
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[3] / 'deploy/worker-session/teleagent-resource-topology-watch'
MODULE = runpy.run_path(str(SOURCE))
BOOT = '11111111-2222-3333-4444-555555555555\n'


def selftest():
    with tempfile.TemporaryDirectory(prefix='teleagent-watch-kernel-') as root:
        os.mkdir(root + '/existing', 0o700)
        descriptor = os.open(root, MODULE['DIRECTORY_FLAGS'])
        try:
            watcher = MODULE['TopologyWatch'](descriptor, time.monotonic())
            try:
                for payload in [b'', b'\0', struct.pack('iIII', -1, 0x4000, 0, 0),
                                struct.pack('iIII', 1, 0x8000, 0, 0),
                                struct.pack('iIII', 1, 0x2000, 0, 0)]:
                    with patch('os.read', return_value=payload):
                        try:
                            watcher.drain()
                        except MODULE['Refused']:
                            pass
                        else:
                            raise AssertionError('raw event/EOF was accepted')
                with patch('os.read', side_effect=OSError(errno.EIO, 'fixture')):
                    try:
                        watcher.drain()
                    except MODULE['Refused']:
                        pass
                    else:
                        raise AssertionError('read error was accepted')
            finally:
                watcher.close()
            original = os.scandir
            fired = False

            def changing_scan(fd):
                nonlocal fired
                if not fired:
                    fired = True
                    os.mkdir(root + '/vanished-before-first-snapshot', 0o700)
                    os.rmdir(root + '/vanished-before-first-snapshot')
                return original(fd)

            with patch('os.scandir', side_effect=changing_scan):
                try:
                    MODULE['TopologyWatch'](descriptor, time.monotonic())
                except MODULE['Refused']:
                    pass
                else:
                    raise AssertionError('setup churn was accepted')
        finally:
            os.close(descriptor)
    inherited = os.open('/dev/null', os.O_RDONLY)
    MODULE['prepare_process']()
    try:
        os.fstat(inherited)
    except OSError as error:
        assert error.errno == errno.EBADF
    else:
        raise AssertionError('unrelated inherited descriptor survived')
    print('injected raw overflow/ignored/unmount/EOF/read-error and real setup churn refused; inherited FD closed')


def self_deadline(root):
    started = time.monotonic()
    child = subprocess.Popen(['/usr/bin/python3', '-I', __file__, root, 'valid'],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        assert child.stdout.readline()
        assert child.wait(timeout=4) == 75
        assert 2.8 <= time.monotonic() - started < 4
        print('independent helper deadline refused and reaped')
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
        child.stdin.close()
        child.stdout.close()


def parent_death(root):
    libc = ctypes.CDLL('libc.so.6', use_errno=True)
    assert libc.prctl(36, 1, 0, 0, 0) == 0  # this fixture process is the subreaper
    read_fd, write_fd = os.pipe()
    expected_parent = os.getpid()
    coordinator = os.fork()
    if coordinator == 0:
        if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != expected_parent:
            os._exit(4)
        os.close(read_fd)
        child = subprocess.Popen(['/usr/bin/python3', '-I', __file__, root, 'valid'],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        readiness = child.stdout.readline()
        if not readiness:
            os._exit(2)
        os.write(write_fd, str(child.pid).encode('ascii'))
        os.close(write_fd)
        time.sleep(10)
        os._exit(3)
    os.close(write_fd)
    try:
        observer = int(os.read(read_fd, 64))
        os.kill(coordinator, signal.SIGKILL)
        assert os.waitpid(coordinator, 0)[0] == coordinator
        until = time.monotonic() + 1.5
        while time.monotonic() < until:
            pid, status = os.waitpid(observer, os.WNOHANG)
            if pid == observer:
                assert status != 0
                print('parent-death observer reaped')
                return
            time.sleep(0.01)
        os.kill(observer, signal.SIGKILL)
        os.waitpid(observer, 0)
        raise AssertionError('observer survived coordinator death')
    finally:
        os.close(read_fd)


def fixture(root, mode):
    MODULE['prepare_process']()
    descriptor = os.open(root, MODULE['DIRECTORY_FLAGS'])
    watcher = MODULE['TopologyWatch'](descriptor, time.monotonic())
    try:
        if mode == 'valid':
            MODULE['serve'](watcher, BOOT)
            return
        if mode == 'partial':
            os.write(1, b'{')
            return
        os.write(1, watcher.ready(BOOT))
        if mode == 'stall':
            time.sleep(5)
            return
        if mode == 'crash':
            os._exit(75)
        command = sys.stdin.buffer.readline()
        nonce = command.removeprefix(b'CHECK ').strip()
        if mode == 'wrong-nonce':
            nonce = b'0' * 64
        response = b'CHECKED ' + nonce + b'\n'
        if mode == 'no-receipt':
            return
        os.write(1, response)
        if mode == 'duplicate':
            os.write(1, response)
        if mode == 'extra-byte':
            os.write(1, b'x')
        if mode == 'receipt-crash':
            os._exit(75)
    finally:
        watcher.close()
        os.close(descriptor)


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'selftest':
            selftest()
        elif sys.argv[2] == 'parent-death':
            parent_death(sys.argv[1])
        elif sys.argv[2] == 'self-deadline':
            self_deadline(sys.argv[1])
        else:
            fixture(sys.argv[1], sys.argv[2])
    except MODULE['Refused']:
        traceback.print_exc()
        sys.exit(75)
