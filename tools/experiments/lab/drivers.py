"""Local, explicit SSH and Docker transports share the same frozen worker."""
import json
import os
import re
from pathlib import Path, PurePosixPath
import shlex
import subprocess
import sys

from .common import LabError, encoded
from .config import TOOLS

PROBE = r'''
import json,os,platform,shutil,sys
from pathlib import Path
root=Path(sys.argv[1]).expanduser()
while not root.exists(): root=root.parent
capabilities=[]
if os.name!='nt': capabilities+=['process-groups','address-space-limit']
if Path('/proc/self/status').exists(): capabilities+=['linux-proc']
memory=None
if Path('/proc/meminfo').exists():
 for line in Path('/proc/meminfo').read_text().splitlines():
  if line.startswith('MemTotal:'): memory=int(line.split()[1])*1024
print(json.dumps({'python':list(sys.version_info[:3]),'system':platform.system(),
 'architecture':platform.machine(),'memory_bytes':memory,
 'free_bytes':shutil.disk_usage(str(root)).free,'capabilities':capabilities,
 'missing_env':[name for name in json.loads(sys.argv[2]) if name not in os.environ]}))
'''


class Driver:
    def __init__(self, config, state=None):
        self.config = config
        self.profile = config["profile"]
        self.state = dict(state or {})
        self.python = self.profile.get("python", "python3")
        if self.profile["driver"] == "local" and self.python == "python3":
            self.python = sys.executable

    def host(self, command, data=None, input_file=None, output_file=None, timeout=30):
        if "ssh" in self.profile:
            ssh = self.profile["ssh"]
            command = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=" + str(
                ssh.get("connect_timeout_seconds", 10)), "--", ssh["alias"],
                " ".join(shlex.quote(str(argument)) for argument in command)]
        options = {"stdout": output_file or subprocess.PIPE,
                   "stderr": subprocess.PIPE, "timeout": timeout}
        if input_file is not None:
            options["stdin"] = input_file
        else:
            options["input"] = data
        result = subprocess.run([str(argument) for argument in command], **options)
        if result.returncode:
            message = result.stderr.decode("utf-8", errors="replace")[-4000:]
            raise LabError("Selected environment command failed: " + message)
        return result.stdout

    def container_options(self):
        settings = self.profile["container"]
        result = ["--network", settings["network"], "--memory", str(settings["memory_mib"]) + "m",
                  "--cpus", str(settings["cpus"]), "--pids-limit", str(settings["pids"]),
                  "--cap-drop", "ALL", "--security-opt", "no-new-privileges"]
        for name in self.profile.get("env_from", []):
            result += ["--env", name]
        return result

    def doctor(self):
        command = [self.python, "-c", PROBE, self.config["work_root"],
                   json.dumps(self.profile.get("env_from", []))]
        if self.profile["driver"] == "container":
            image = self.host(["docker", "image", "inspect", "--format", "{{.Id}}",
                               self.profile["container"]["image"]]).decode().strip()
            if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
                raise LabError("Docker did not resolve an immutable image ID")
            self.state["image_id"] = image
            command = ["docker", "run", "--rm"] + self.container_options() + [
                "--entrypoint", self.python, image] + command[1:]
        observed = json.loads(self.host(command, timeout=60).decode())
        if observed["python"] < [3, 6, 0]:
            raise LabError("Execution Python must be at least 3.6")
        if self.profile["driver"] == "container" and self.profile["container"]["network"] == "none":
            observed["capabilities"].append("network-isolation")
        missing = set(self.config["benchmark"].get("requires", [])) - set(observed["capabilities"])
        if missing or observed["missing_env"]:
            raise LabError("Missing benchmark capabilities/environment references: " +
                           ", ".join(sorted(missing) + observed["missing_env"]))
        if self.profile["limits"].get("address_space_mib", 0) and "address-space-limit" not in observed["capabilities"]:
            raise LabError("Address-space limits are unavailable in this environment")
        if observed["free_bytes"] < self.profile["limits"]["min_free_mib"] * 1048576:
            raise LabError("Execution environment lacks its disk reserve")
        self.state["observed"] = observed
        return observed

    def stage(self, run, identity, bundle):
        self.state.update({"key": identity["key"], "job_sha256": bundle["job_sha256"]})
        root = self.config["work_root"]
        command = [self.python, "-c", (TOOLS / "stage.py").read_text(encoding="utf-8"),
                   root, identity["key"], bundle["job_sha256"],
                   str(self.profile["limits"]["max_bundle_mib"] * 1048576)]
        if self.profile["driver"] == "container":
            name = "prts-lab-" + identity["key"]
            self.state["container_name"] = name
            self.host(["docker", "run", "--detach", "--name", name,
                       "--label", "prts.lab=" + identity["key"],
                       "--label", "prts.job=" + bundle["job_sha256"]] + self.container_options() + [
                           "--entrypoint", self.python, self.state["image_id"], "-c",
                           "import time; time.sleep(86400)"])
            command = ["docker", "exec", "-i", name] + command
        with (Path(run) / "bundle.tar").open("rb") as stream:
            self.host(command, input_file=stream, timeout=300)

    def checked_container(self):
        if self.profile["driver"] != "container":
            return
        name = self.state["container_name"]
        info = json.loads(self.host(["docker", "inspect", name]).decode())[0]
        labels = info["Config"]["Labels"]
        if (labels.get("prts.lab") != self.state["key"] or
                labels.get("prts.job") != self.state["job_sha256"] or
                info["Image"] != self.state["image_id"]):
            raise LabError("Container ownership/image does not match")
        if not info["State"]["Running"]:
            self.host(["docker", "start", name])

    def invoke(self, action, request=None, output_file=None):
        self.checked_container()
        path_type = Path if self.profile["driver"] == "local" else PurePosixPath
        worker = path_type(self.config["work_root"]) / self.state["key"] / "bundle/control/worker.py"
        command = [self.python, "-B", str(worker), action, self.state["key"], self.state["job_sha256"]]
        if self.profile["driver"] == "container":
            command = ["docker", "exec", "-i", self.state["container_name"]] + command
        limit = self.profile["limits"]["max_trial_seconds"] + 30 if action == "execute" else 300
        raw = self.host(command, data=encoded(request or {}) + b"\n", output_file=output_file, timeout=limit)
        return None if output_file is not None else json.loads(raw.decode())

    def cleanup(self, postflight):
        result = self.invoke("cleanup", {"raw_files": postflight["raw_files"]})
        if self.profile["driver"] == "container":
            self.checked_container()
            self.host(["docker", "rm", "--force", self.state["container_name"]])
            result["container_removed"] = True
        return result

    def cleanup_stage(self):
        """Remove a failed, exclusively owned staging area with no trial data."""
        if self.profile["driver"] == "container":
            name = self.state["container_name"]
            names = self.host(["docker", "container", "ls", "--all", "--format", "{{.Names}}",
                               "--filter", "name=^" + name + "$"]).decode().splitlines()
            if not names:
                return {"staging_removed": True, "container_absent": True}
        self.checked_container()
        script = '''import json,os,shutil,stat,sys
from pathlib import Path
def readonly(function,name,error):
 if os.name!='nt' or not isinstance(error[1],PermissionError) or os.path.islink(name): raise error[1]
 os.chmod(name,stat.S_IREAD|stat.S_IWRITE)
 function(name)
root=Path(sys.argv[1]); key=sys.argv[2]; expected=sys.argv[3]
run=root/key
if not root.is_absolute() or root.is_symlink() or run.is_symlink():
 raise ValueError('Unsafe staging directory')
if run.exists():
 lock=(run/'.lock').open('a+b')
 if os.name=='nt':
  import msvcrt
  lock.write(b'0'); lock.flush(); lock.seek(0)
  msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
 else:
  import fcntl
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 if json.loads((run/'owner.json').read_text()) != {'key':key,'job_sha256':expected}:
  raise ValueError('Staging ownership mismatch')
 if (run/'raw').exists() or (run/'work').exists():
  raise ValueError('Trial data exists; collect it before cleanup')
 for child in run.iterdir():
  if child.name not in ('.lock','owner.json'):
   if child.is_dir() and not child.is_symlink(): shutil.rmtree(str(child),onerror=readonly)
   else: child.unlink()
print(json.dumps({'staging_removed':True,'ownership_retained':True}))
'''
        command = [self.python, "-c", script, self.config["work_root"],
                   self.state["key"], self.state["job_sha256"]]
        if self.profile["driver"] == "container":
            command = ["docker", "exec", self.state["container_name"]] + command
        result = json.loads(self.host(command).decode())
        if self.profile["driver"] == "container":
            self.checked_container()
            self.host(["docker", "rm", "--force", self.state["container_name"]])
            result["container_removed"] = True
        return result
