"""Bounded subprocess capture with descendant cleanup and retained partial logs."""
import os
import signal
import subprocess
import threading
import time


def capture(command, request, cwd, environment, output, timeout, maximum, address_space=0):
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
    process = subprocess.Popen(command, **options)

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

    def ended():
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
    if overflow.is_set():
        status = "output_limit"
    if status == "complete" and returncode != 0:
        status = "execution_error"
    return {"status": status, "returncode": returncode,
            "elapsed_seconds": time.monotonic() - started}
