from __future__ import annotations

import asyncio
import ast
import json
import re
from pathlib import Path

from mcp.server import MCPServer

from prts_mcp.tools_gamedata import register_gamedata_tools
from prts_mcp.tools_prts import register_prts_tools
from prts_mcp.tools_story import register_story_tools


EXPECTED_TOOL_SURFACE = {
    "search_prts": ("query", "limit", "search_mode", "filter_technical"),
    "prts_page": ("page_title", "action", "section_index", "direction", "limit"),
    "get_operator_archives": ("name",),
    "get_operator_voicelines": ("name",),
    "get_operator_basic_info": ("name",),
    "list_enemies": ("threat_level", "limit", "offset", "full"),
    "get_enemy_info": ("name", "stage_id"),
    "get_stage_enemies": ("stage_id",),
    "get_enemy_appearances": ("name", "limit", "offset"),
    "list_story_events": ("category",),
    "list_stories": ("event_id", "include_summaries"),
    "get_story_summary": ("story_key",),
    "read_story": ("story_key", "include_narration"),
    "read_activity": ("event_id", "include_narration", "page", "page_size"),
    "list_stages": ("chapter", "type", "limit", "offset"),
    "get_stage_info": ("stage_id",),
    "list_items": ("category", "limit", "offset"),
    "get_item_info": ("name",),
    "search": ("scope", "pattern", "max_results"),
    "search_stories": ("pattern", "character", "line_type", "context_lines", "max_results", "event_id"),
    "get_operator_memoirs": ("name",),
    "find_character_appearances": ("name", "scope", "max_events"),
    "find_speakers_in": ("event_id",),
    # operator_artwork is conditionally registered (IMAGES_ENABLED=true); the
    # signature is frozen at the source level like the other tools.
    "operator_artwork": ("operator_name", "action", "artwork_id", "variant"),
}


def _build_registered_app() -> MCPServer:
    app = MCPServer("tool-surface-test")
    register_prts_tools(app)
    register_gamedata_tools(app)
    register_story_tools(app)
    return app


def _collect_tool_functions() -> dict[str, ast.FunctionDef | ast.AsyncFunctionDef]:
    """Parse all tools_*.py modules under src/prts_mcp/ for tool function definitions.

    The server tool registrations were split into focused modules and each tool
    function is nested inside a register_*() wrapper, so we walk recursively
    to find all def/async def nodes regardless of nesting depth.
    """
    src = Path(__file__).parents[1] / "src" / "prts_mcp"
    functions: dict[str, ast.FunctionDef | ast.AsyncFunctionDef] = {}
    for tool_file in sorted(src.glob("tools_*.py")):
        module = ast.parse(tool_file.read_text(encoding="utf-8"))
        for node in ast.walk(module):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                functions[node.name] = node
    return functions


def _return_annotation(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> str | None:
    if fn.returns is None:
        return None
    return ast.unparse(fn.returns)


def test_python_tool_function_signatures_are_frozen() -> None:
    # Alpha hardening intentionally freezes required and optional parameters.
    # Relax this before 1.0 final if additive optional parameters become policy.
    functions = _collect_tool_functions()

    for name, expected_params in EXPECTED_TOOL_SURFACE.items():
        assert name in functions, f"Tool {name!r} not found in any tools_*.py module"
        fn = functions[name]
        params = [arg.arg for arg in fn.args.args]
        assert tuple(params) == expected_params, f"Signature mismatch for {name!r}"


def test_python_tool_functions_return_explicit_call_tool_results() -> None:
    functions = _collect_tool_functions()

    for name in EXPECTED_TOOL_SURFACE:
        assert name in functions, f"Tool {name!r} not found in any tools_*.py module"
        assert _return_annotation(functions[name]) == "object", (
            f"Tool {name!r} must stay annotated as -> object so MCPServer does "
            "not derive an outputSchema that breaks explicit CallToolResult."
        )


def test_registered_tool_manifest_has_no_output_schema() -> None:
    app = _build_registered_app()

    tools = {tool.name: tool for tool in asyncio.run(app.list_tools())}
    # operator_artwork is conditionally registered (IMAGES_ENABLED=true) and is
    # not part of the default registered manifest; exclude it from the check.
    expected_registered = {
        name for name in EXPECTED_TOOL_SURFACE if name != "operator_artwork"
    }
    assert set(tools) == expected_registered

    for name, tool in tools.items():
        assert tool.output_schema is None, f"{name} still has output_schema"


def _extract_field_bounds(
    fn: ast.FunctionDef | ast.AsyncFunctionDef,
) -> dict[str, dict[str, int | None]]:
    """Read ge/le/default off each parameter's ``Annotated[..., Field(...)]``.

    Function parameters carry the annotation on ``arg.annotation`` (an
    ``ast.Subscript`` on ``Annotated`` whose tuple's second element is the
    ``Field(...)`` call), not on ``ast.AnnAssign``. Values are literal ints or
    ``None`` everywhere in the codebase, so ``ast.literal_eval`` is safe.
    """
    bounds: dict[str, dict[str, int | None]] = {}
    for arg in fn.args.args:
        ann = arg.annotation
        if not (
            isinstance(ann, ast.Subscript)
            and isinstance(ann.value, ast.Name)
            and ann.value.id == "Annotated"
        ):
            continue
        sl = ann.slice
        if not isinstance(sl, ast.Tuple) or len(sl.elts) < 2:
            continue
        field_call = sl.elts[1]
        if not (
            isinstance(field_call, ast.Call)
            and isinstance(field_call.func, ast.Name)
            and field_call.func.id == "Field"
        ):
            continue
        kw: dict[str, int | None] = {}
        for k in field_call.keywords:
            if k.arg in ("ge", "le", "default"):
                kw[k.arg] = ast.literal_eval(k.value)
        if "ge" in kw or "le" in kw:
            bounds[arg.arg] = {
                "min": kw.get("ge"),
                "max": kw.get("le"),
                "default": kw.get("default"),
            }
    return bounds


def test_python_numeric_fields_match_parity_contract() -> None:
    """Every bounded numeric ``Field`` must match the shared cross-impl contract.

    The contract (tests/parity-fixtures/tool-bounds.json) is the single source
    of truth both suites assert against, so unilateral drift on either side
    fails its own test. Closes the names-only blind spot of the frozen-surface
    test above.
    """
    contract_path = (
        Path(__file__).parents[2] / "tests" / "parity-fixtures" / "tool-bounds.json"
    )
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    functions = _collect_tool_functions()

    for tool, params in contract.items():
        assert tool in functions, f"{tool!r} missing from tools_*.py"
        actual = _extract_field_bounds(functions[tool])
        for param, expected in params.items():
            assert param in actual, (
                f"{tool}.{param} has no Field bounds (ge/le); "
                f"contract expects {expected}"
            )
            assert actual[param] == expected, (
                f"{tool}.{param} bounds mismatch: "
                f"py={actual[param]}, contract={expected}"
            )


def test_user_pattern_regex_handles_astral_codepoints() -> None:
    """Python re is Unicode-default: ``.`` matches a whole astral code point.

    This is the parity property the TS /u flag change aligns to: without /u,
    JS ``.`` treats an astral char as two UTF-16 surrogates so ``^.$`` fails;
    with /u it matches the whole code point like Python. (Residual gap: JS
    ``\\w`` stays ASCII-only even with /u whereas Python ``\\w`` matches CJK —
    fundamental, not flag-fixable, tracked as a known limitation.)
    """
    assert re.compile(r"^.$", re.IGNORECASE).search("\U0001D49C") is not None
