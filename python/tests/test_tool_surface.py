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
    "list_stories": ("event_id", "include_summaries"),
    "get_event_summary": ("event_id",),
    "get_story_summary": ("story_key",),
    "read_story": ("story_key", "include_narration"),
    "read_activity": ("event_id", "include_narration", "page", "page_size"),
    "list_search_scopes": (),
    "search_data": ("pattern", "scope", "max_results"),
    "search_stories": ("pattern", "character", "line_type", "context_lines", "max_results", "event_id"),
}


def test_python_tool_function_signatures_are_frozen() -> None:
    # Alpha hardening intentionally freezes required and optional parameters.
    # Relax this before 1.0 final if additive optional parameters become policy.
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
