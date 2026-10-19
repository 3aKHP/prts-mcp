"""Benchmark response checks, shared by the coordinator and execution worker."""
from pathlib import Path

from .common import LabError, read_json
from .schema import validate


def check_response(response, benchmark):
    schema = Path(__file__).resolve().parent.parent / "schemas" / "response.schema.json"
    validate(response, read_json(schema))
    cases = [row["id"] for row in response["cases"]]
    expected = [row["id"] for row in benchmark["cases"]]
    if len(set(cases)) != len(cases) or set(cases) != set(expected):
        raise LabError("Adapter must return every declared case exactly once")
    for row in response["cases"]:
        if set(row["metrics"]) != set(benchmark["metrics"]):
            raise LabError("Adapter metric names do not match the benchmark")
        if benchmark["equivalence"] == "output-sha256" and "output" not in row:
            raise LabError("Output equivalence requires an output for every case")
        for name, value in row["metrics"].items():
            specification = benchmark["metrics"][name]
            if not specification.get("minimum", -float("inf")) <= value <= specification.get("maximum", float("inf")):
                raise LabError("Metric exceeds its declared domain: " + name)
