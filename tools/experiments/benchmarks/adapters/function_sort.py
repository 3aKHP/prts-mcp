"""Offline example: time a function batch, excluding interpreter startup."""
import json
import random
import statistics
import sys
import time


def insertion(values):
    result = list(values)
    for index in range(1, len(result)):
        value, previous = result[index], index - 1
        while previous >= 0 and result[previous] > value:
            result[previous + 1] = result[previous]
            previous -= 1
        result[previous + 1] = value
    return result


def main():
    request = json.load(sys.stdin)
    parameters = request["parameters"]
    function = insertion if parameters["algorithm"] == "insertion" else sorted
    cases = []
    for case in request["cases"]:
        source = random.Random(request["context"]["seed"] + case["input"]["size"])
        values = [source.randrange(-100000, 100000) for _ in range(case["input"]["size"])]
        for _ in range(parameters["warmup"]):
            function(values)
        samples = []
        for _ in range(parameters["batches"]):
            started = time.perf_counter()
            for _ in range(parameters["iterations"]):
                output = function(values)
            samples.append((time.perf_counter() - started) * 1000)
        if output != sorted(values):
            raise ValueError("Sort result is incorrect")
        cases.append({"id": case["id"], "metrics": {"batch_ms": statistics.median(samples)},
                      "output": output, "details": {"batch_ms": samples}})
    print(json.dumps({"version": 1, "cases": cases}))


if __name__ == "__main__":
    main()
