"""Deterministic metadata coverage example, not an LLM/rubric benchmark."""
import json
from pathlib import Path
import sys


def main():
    request = json.load(sys.stdin)
    definitions = json.loads(Path(request["parameters"]["definitions"]).read_text(encoding="utf-8"))
    cases = []
    for case in request["cases"]:
        tool = definitions[case["input"]["tool"]]
        properties = tool["inputSchema"]["properties"]
        expected = case["input"]["required"]
        descriptions = [item.get("description", "").strip() for item in properties.values()]
        coverage = sum(bool(text) for text in descriptions) / max(1, len(properties))
        declared = sum(name in properties for name in expected) / max(1, len(expected))
        characters = len(tool.get("description", "")) + sum(len(text) for text in descriptions)
        cases.append({"id": case["id"], "metrics": {
            "parameter_coverage": coverage, "required_declared": declared,
            "description_characters": characters}, "output": tool})
    print(json.dumps({"version": 1, "cases": cases}, ensure_ascii=False))


if __name__ == "__main__":
    main()
