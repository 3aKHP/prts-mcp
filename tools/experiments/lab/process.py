"""Bounded subprocess capture with descendant cleanup and retained partial logs."""
import os
from pathlib import Path
import signal
import select
import subprocess
import sys
import threading
import time


def capture(command, request, cwd, environment, output, timeout, maximum, address_space=0, lease_fd=None):
    overflow = threading.Event()
    started = time.monotonic()

    def limits():
        if address_space:
            import resource
            size = address_space * 1048576
            resource.setrlimit(resource.RLIMIT_AS, (size, size))

    options = {"cwd": str(cwd), "env": environment, "stdin": subprocess.PIPE,
               "stdout": subprocess.PIPE, "stderr": subprocess.PIPE}
    if os.name == "nt":
        options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options["start_new_session"] = True
        if address_space:
            options["preexec_fn"] = limits
    heartbeat = None
    status_read = None
    if os.name != "nt":
        read_end, heartbeat = os.pipe()
        status_read, status_write = os.pipe()
        options["pass_fds"] = (read_end, status_write) + ((lease_fd,) if lease_fd is not None else ())
        command = [sys.executable, "-B", str(Path(__file__).with_name("supervise.py")),
                   str(read_end), str(status_write), str(timeout + 0.2)] + list(command)
    try:
        process = subprocess.Popen(command, **options)
    except BaseException:
        if heartbeat is not None:
            os.close(heartbeat)
            os.close(status_read)
        raise
    finally:
        if os.name != "nt":
            os.close(read_end)
            os.close(status_write)

    def copy(source, path):
        count = 0
        with path.open("xb") as stream:
            while True:
                block = source.read(65536)
                if not block:
                    break
                remaining = max(0, maximum - count)
                stream.write(block[:remaining])
                stream.flush()
                count += len(block)
                if count > maximum:
                    overflow.set()
            os.fsync(stream.fileno())

    def feed():
        try:
            process.stdin.write(request)
            process.stdin.close()
        except (BrokenPipeError, OSError):
            pass

    readers = [threading.Thread(target=copy, args=(process.stdout, output / "stdout.json")),
               threading.Thread(target=copy, args=(process.stderr, output / "stderr.log")),
               threading.Thread(target=feed)]
    for thread in readers:
        thread.daemon = True
        thread.start()

    adapter_code = []
    def ended():
        if status_read is not None and select.select([status_read], [], [], 0)[0]:
            value = os.read(status_read, 64)
            if value:
                adapter_code.append(int(value))
                return True
        # On Linux, retain the zombie until its process group is cleaned up;
        # this prevents PID reuse between detecting exit and killing children.
        if hasattr(os, "waitid") and hasattr(os, "WNOWAIT"):
            return os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
        return process.poll() is not None

    def stop(sig):
        try:
            if os.name == "nt":
                subprocess.call(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass

    status = "complete"
    try:
        while not ended():
            if overflow.is_set() or time.monotonic() - started >= timeout:
                status = "output_limit" if overflow.is_set() else "timeout"
                break
            time.sleep(0.02)
    finally:
        stop(signal.SIGTERM)
        time.sleep(0.05)
        stop(getattr(signal, "SIGKILL", signal.SIGTERM))
        returncode = process.wait()
        for thread in readers:
            thread.join(timeout=3)
        for pipe in (process.stdout, process.stderr):
            pipe.close()
        if heartbeat is not None:
            os.close(heartbeat)
            os.close(status_read)
    if adapter_code:
        returncode = adapter_code[0]
    elif status == "complete" and time.monotonic() - started >= timeout:
        status = "timeout"
    if overflow.is_set():
        status = "output_limit"
    if status == "complete" and returncode != 0:
        status = "execution_error"
    return {"status": status, "returncode": returncode,
            "elapsed_seconds": time.monotonic() - started}
