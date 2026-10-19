"""Case/round pairing and metric-defined estimates; no universal score."""
import statistics
from pathlib import Path

from .integrity import LabError, digest, file_hash, inventory, read_json
from .response import check_response


def statistic(values, method):
    return statistics.mean(values) if method == "mean" else statistics.median(values)


def describe(values, method):
    if not values:
        return {"n": 0, "estimate": None}
    return {"n": len(values), "estimate": statistic(values, method),
            "mean": statistics.mean(values), "median": statistics.median(values),
            "min": min(values), "max": max(values)}


def attempts(run):
    result = {}
    for path in sorted((Path(run) / "evidence" / "raw").glob("*/*")):
        if not path.is_dir():
            raise LabError("Unexpected raw evidence entry")
        trial = path.parent.name
        dispatch = Path(run) / "dispatches" / trial / (path.name + ".json")
        request = read_json(dispatch)
        metadata_error = False
        record = None
        for name in ("invocation.json", "result.json"):
            try:
                value = read_json(path / name)
            except (FileNotFoundError, ValueError, LabError, UnicodeError):
                metadata_error = True
                continue
            if name == "invocation.json" and value != request:
                raise LabError("Worker invocation differs from its durable dispatch")
            if name == "result.json":
                if not isinstance(value, dict):
                    raise LabError("Invalid result metadata")
                record = value
        if record is None:
            record = dict(request, status="interrupted", elapsed_seconds=request["timeout_seconds"])
        elif metadata_error:
            # A complete result without the matching invocation is inconsistent
            # evidence, rather than permission to discard a successful sample.
            raise LabError("Result exists without intact invocation metadata")
        else:
            record = dict(record)
        record["directory"] = str(path)
        result.setdefault(trial, []).append(record)
    # A lost transport may have dispatched work even if no remote bytes have
    # arrived. Charge its full deadline and retain its attempt number.
    for path in sorted((Path(run) / "dispatches").glob("*/*.json")):
        request = read_json(path)
        group = result.setdefault(request["trial"], [])
        if not any(item["attempt"] == request["attempt"] for item in group):
            group.append(dict(request, status="dispatch_unknown",
                              elapsed_seconds=request["timeout_seconds"]))
    for group in result.values():
        group.sort(key=lambda item: item["attempt"])
    return result


def completed(record, benchmark):
    if record["status"] != "complete":
        return None
    path = Path(record["directory"]) / "measured.json"
    if file_hash(path) != record["measured_sha256"]:
        raise LabError("Measured evidence changed")
    value = read_json(path)
    check_response(value, benchmark)
    return value


def summarize(run):
    snapshot = read_json(Path(run) / "snapshot.json")
    plan, benchmark = snapshot["config"]["plan"], snapshot["config"]["benchmark"]
    postflight = read_json(Path(run) / "evidence" / "postflight.json")
    if (postflight["identity"] != snapshot["identity"] or
            inventory(Path(run) / "evidence" / "raw") != postflight["raw_files"]):
        raise LabError("Collected evidence identity/inventory changed")
    expected = {"r{:04d}-{}".format(index, variant): (index, variant)
                for index, row in enumerate(snapshot["config"]["orders"]) for variant in row}
    records = attempts(run)
    if set(records) - set(expected):
        raise LabError("Evidence references a trial outside the frozen schedule")
    data, failures = {}, []
    for trial, group in records.items():
        for record in group:
            value = completed(record, benchmark)
            if value is None:
                failures.append({"trial": trial, "attempt": record["attempt"], "status": record["status"]})
                continue
            if trial in data:
                raise LabError("Multiple completed attempts cannot be selected after observing results")
            index, variant = expected[trial]
            if record["trial"] != trial or record["round"] != index or record["variant"] != variant:
                raise LabError("Evidence identity differs from the frozen schedule")
            data[trial] = {row["id"]: row for row in value["cases"]}
    samples = {}
    for trial, rows in data.items():
        index, variant = expected[trial]
        for metric in benchmark["metrics"]:
            values = []
            for case, row in rows.items():
                number = row["metrics"][metric]
                samples.setdefault((variant, case, metric), {})[index] = number
                values.append(number)
            # Each task has equal weight within a round. Round count, not calls
            # hidden inside an adapter, determines n; independence is pack-specific.
            samples.setdefault((variant, "aggregate", metric), {})[index] = statistics.mean(values)
    estimates = {}
    for (variant, case, metric), values in samples.items():
        estimates.setdefault(variant, {}).setdefault(case, {})[metric] = describe(
            list(values.values()), benchmark["metrics"][metric]["aggregate"])
    checks = []
    for specification in plan["checks"]:
        check = dict(specification)
        key = (check["variant"], check["case"], check["metric"])
        values = samples.get(key, {})
        method = benchmark["metrics"][check["metric"]]["aggregate"]
        operator = check["operator"]
        if operator.startswith(("delta_", "ratio_")):
            baseline = samples.get((check["baseline"], check["case"], check["metric"]), {})
            pairs = [(values[index], baseline[index]) for index in sorted(set(values) & set(baseline))]
            derived = [left - right for left, right in pairs] if operator.startswith("delta_") else [
                left / right for left, right in pairs if right != 0]
            if len(derived) != len(pairs):
                derived = []  # An undefined ratio must never silently pass.
            check["n"] = len(derived)
            check["observed"] = statistic(derived, method) if derived else None
        else:
            check["n"] = len(values)
            check["observed"] = statistic(list(values.values()), method) if values else None
        observed = check["observed"]
        check["passed"] = observed is not None and check["n"] == plan["design"]["rounds"] and (
            observed >= check["value"] if operator.endswith("gte") else observed <= check["value"])
        checks.append(check)
    mismatches = []
    if benchmark["equivalence"] == "output-sha256":
        baseline = plan["variants"][0]["id"]
        oracle = {}
        # Compare within paired rounds: a benchmark may deliberately vary its
        # random seed across rounds while keeping it identical between arms.
        for index in range(plan["design"]["rounds"]):
            for case, row in data.get("r{:04d}-{}".format(index, baseline), {}).items():
                oracle[(index, case)] = digest(row["output"])
        for trial, rows in data.items():
            index, _ = expected[trial]
            for case, row in rows.items():
                observed = digest(row["output"])
                if (index, case) not in oracle or observed != oracle[(index, case)]:
                    mismatches.append({"trial": trial, "case": case,
                                       "expected": oracle.get((index, case)), "observed": observed})
    missing = sorted(set(expected) - set(data))
    postflight = read_json(Path(run) / "evidence" / "postflight.json")
    unchanged = not postflight["changed_files"]
    return {"version": 1, "experiment": plan["id"],
            "benchmark": {"id": benchmark["id"], "revision": benchmark["revision"],
                          "sha256": digest(benchmark), "unit": benchmark["unit"],
                          "metrics": benchmark["metrics"]},
            "complete": not missing, "passed": not missing and unchanged and not mismatches
            and all(check["passed"] for check in checks),
            "completed_trials": len(data), "expected_trials": len(expected),
            "missing_trials": missing, "retained_unsuccessful_attempts": failures,
            "input_identity_unchanged": unchanged, "output_mismatches": mismatches,
            "estimates": estimates, "checks": checks}
