"""POSIX process-group owner with a parent-death pipe and inherited run lease.

The coordinator may disappear, including via SIGKILL. This process retains the
worker's file-lock descriptor until its whole adapter group is stopped.
"""
import os
import select
import signal
import subprocess
import sys
import time


def main():
    heartbeat = int(sys.argv[1])
    status = int(sys.argv[2])
    deadline = time.monotonic() + float(sys.argv[3])
    def stop(number=None, frame=None):
        os.killpg(os.getpid(), signal.SIGKILL)
    for name in ("SIGTERM", "SIGINT", "SIGHUP"):
        signal.signal(getattr(signal, name), stop)
    # Avoid launching work after a parent that died before our interpreter ran.
    if select.select([heartbeat], [], [], 0)[0] and not os.read(heartbeat, 1):
        return 130
    try:
        process = subprocess.Popen(sys.argv[4:])
        reported = False
        while True:
            if process.poll() is not None and not reported:
                os.write(status, str(process.returncode).encode('ascii'))
                reported = True
            closed = select.select([heartbeat], [], [], 0.05)[0]
            if (closed and not os.read(heartbeat, 1)) or time.monotonic() >= deadline:
                break
    finally:
        # Keep the lock and live group-leader PID until every descendant has
        # received KILL, including children that ignore TERM after a normal exit.
        stop()


if __name__ == '__main__':
    sys.exit(main())
