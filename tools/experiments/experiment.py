#!/usr/bin/env python3
"""Versioned comparative evaluations, independent of topology and metric type."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

from lab import analysis, evidence, runner
from lab.integrity import LabError, RunLock, write_json
from lab.config import ROOT, load
from lab.drivers import Driver
from lab.initialize import initialize


def parser():
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="action")
    init = commands.add_parser("init", help="Create private config and an offline example")
    init.add_argument("--directory", default="dev/experiments/private/demo")
    init.add_argument("--driver", choices=["local", "ssh", "container"], default="local")
    init.add_argument("--example", choices=["function-performance", "description-coverage"],
                      default="function-performance")
    for name in ("validate", "doctor", "preview", "run"):
        command = commands.add_parser(name)
        command.add_argument("--plan", required=True)
        command.add_argument("--profile")
        if name == "run":
            command.add_argument("--output", default=str(ROOT / "dev/docs/reports/experiments"))
    for name in ("resume", "analyze", "export", "archive", "cleanup"):
        command = commands.add_parser(name)
        command.add_argument("--run", required=True)
        if name == "resume":
            command.add_argument("--retry-errors", action="store_true")
        if name in ("archive", "export"):
            command.add_argument("--output", required=True)
    return root


def main():
    root = parser()
    args = root.parse_args()
    if args.action is None:
        root.print_help()
        return 2
    if args.action == "init":
        result = initialize(args.directory, args.driver, args.example)
    elif args.action in ("validate", "preview", "doctor", "run"):
        config = load(args.plan, args.profile)
        if args.action == "validate":
            result = {"valid": True, "experiment": config["plan"]["id"],
                      "benchmark": config["benchmark"]["id"], "orders": config["orders"]}
        elif args.action == "preview":
            result = {"visibility": "private", "profile": config["profile_path"],
                      "environment": config["profile"], "resolved_work_root": config["work_root"],
                      "operations_path": config["operations_path"],
                      "operations": Path(config["operations_path"]).read_text(encoding="utf-8"),
                      "hypothesis": config["plan"]["hypothesis"], "orders": config["orders"],
                      "checks": config["plan"]["checks"], "artifacts": config["files"],
                      "benchmark_parameters": config["benchmark"].get("parameters", {}),
                      "variants": config["plan"]["variants"]}
        elif args.action == "doctor":
            result = {"ready": True, "observed": Driver(config).doctor()}
        else:
            run = runner.create(args.plan, args.profile, args.output)
            print(json.dumps({"private_run": str(run)}), flush=True)
            summary = runner.execute(run)
            result = {"run": str(run), "complete": summary["complete"], "passed": summary["passed"]}
    elif args.action == "resume":
        summary = runner.execute(args.run, args.retry_errors)
        result = {"run": str(Path(args.run).resolve()), "complete": summary["complete"], "passed": summary["passed"]}
    elif args.action == "cleanup":
        result = runner.cleanup(args.run)
    else:
        with RunLock(Path(args.run) / ".lock"):
            if args.action == "archive":
                result = evidence.archive(args.run, args.output)
            else:
                summary = analysis.summarize(args.run)
                if args.action == "analyze":
                    write_json(Path(args.run) / "summary.json", summary)
                    result = summary
                else:
                    report = evidence.export(args.run, summary)
                    write_json(args.output, report, exclusive=True)
                    result = {"output": str(Path(args.output).resolve()),
                              "complete": summary["complete"], "passed": summary["passed"]}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return 1 if result.get("passed") is False else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("Interrupted; keep this run and resume from its recorded checkpoint", file=sys.stderr)
        sys.exit(130)
    except (LabError, OSError, ValueError, subprocess.SubprocessError) as error:
        print("Experiment error: " + str(error), file=sys.stderr)
        sys.exit(1)
