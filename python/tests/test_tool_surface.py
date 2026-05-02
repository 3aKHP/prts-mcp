from __future__ import annotations

import ast
from pathlib import Path


EXPECTED_TOOL_SURFACE = {
    "search_prts": ("query", "limit"),
    "read_prts_page": ("page_title",),
    "get_operator_archives": ("operator_name",),
    "get_operator_voicelines": ("operator_name",),
    "get_operator_basic_info": ("operator_name",),
    "list_story_events": ("category",),
    "list_stories": ("event_id",),
    "read_story": ("story_key", "include_narration"),
    "read_activity": ("event_id", "include_narration", "page", "page_size"),
}


def test_python_tool_function_signatures_are_frozen() -> None:
    source = Path(__file__).parents[1] / "src" / "prts_mcp" / "server.py"
    module = ast.parse(source.read_text(encoding="utf-8"))
    functions = {
        node.name: node
        for node in module.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }

    for name, expected_params in EXPECTED_TOOL_SURFACE.items():
        fn = functions[name]
        params = [arg.arg for arg in fn.args.args]
        assert tuple(params) == expected_params
