"""Own an X server process group until the desktop host closes its private pipe.

Separate process rather than preexec_fn: Qt may already have created threads.
"""
import os
import signal
import subprocess
import sys

fd = int(sys.argv[1])
child = subprocess.Popen(sys.argv[2:], pass_fds=[fd], start_new_session=True,
                         stdin=subprocess.DEVNULL)
os.close(fd)

def close(*_):
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
    sys.exit(0)

signal.signal(signal.SIGTERM, close)
signal.signal(signal.SIGINT, close)
sys.stdin.buffer.read()
close()
