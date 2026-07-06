from __future__ import annotations

import asyncio
from typing import Any

import pytest

from prts_mcp.api.prts_wiki import search_prts


class FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class FakeClient:
    def __init__(self, payloads: list[dict[str, Any]]) -> None:
        self.payloads = payloads
        self.requests: list[dict[str, Any]] = []

    async def get(self, _url: str, params: dict[str, Any]) -> FakeResponse:
        self.requests.append(params)
        if not self.payloads:
            raise AssertionError("unexpected request")
        return FakeResponse(self.payloads.pop(0))


async def _no_rate_limit() -> None:
    return None


def _patch_client(
    monkeypatch: pytest.MonkeyPatch,
    payloads: list[dict[str, Any]],
) -> FakeClient:
    client = FakeClient(payloads)
    monkeypatch.setattr("prts_mcp.api.prts_wiki._get_client", lambda: client)
    monkeypatch.setattr("prts_mcp.api.prts_wiki._rate_limit", _no_rate_limit)
    return client


def test_search_prts_resolves_redirect_like_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _patch_client(
        monkeypatch,
        [
            {
                "query": {
                    "searchinfo": {"totalhits": 1},
                    "search": [
                        {"title": "阿米亚", "snippet": "#REDIRECT [[阿米娅]]"},
                    ],
                },
            },
            {
                "query": {
                    "redirects": [{"from": "阿米亚", "to": "阿米娅"}],
                    "pages": {"1": {"title": "阿米娅"}},
                },
            },
        ],
    )

    result = asyncio.run(search_prts("阿米亚", limit=1))

    assert result == {
        "totalhits": 1,
        "results": [{"title": "阿米娅", "snippet": "阿米娅"}],
    }
    assert client.requests[0]["srprop"] == "snippet|redirecttitle|redirectsnippet"
    assert client.requests[1]["redirects"] == "1"
    assert client.requests[1]["titles"] == "阿米亚"


def test_search_prts_filters_technical_pages_but_keeps_totalhits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_client(
        monkeypatch,
        [
            {
                "query": {
                    "searchinfo": {"totalhits": 2},
                    "search": [
                        {"title": "变格凯尔希(敌人)/module", "snippet": "技术数据"},
                        {"title": "凯尔希", "snippet": "罗德岛医生。"},
                    ],
                },
            },
        ],
    )

    result = asyncio.run(search_prts("凯尔希", limit=2))

    assert result == {
        "totalhits": 2,
        "results": [{"title": "凯尔希", "snippet": "罗德岛医生。"}],
    }


def test_search_prts_filter_technical_false_keeps_technical_pages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_client(
        monkeypatch,
        [
            {
                "query": {
                    "searchinfo": {"totalhits": 1},
                    "search": [
                        {"title": "变格凯尔希(敌人)/module", "snippet": "技术数据"},
                    ],
                },
            },
        ],
    )

    result = asyncio.run(search_prts("凯尔希", limit=1, filter_technical=False))

    assert result == {
        "totalhits": 1,
        "results": [{"title": "变格凯尔希(敌人)/module", "snippet": "技术数据"}],
    }


def test_search_prts_filtered_empty_is_structured_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_client(
        monkeypatch,
        [
            {
                "query": {
                    "searchinfo": {"totalhits": 1},
                    "search": [
                        {"title": "敌人数据/module", "snippet": "技术数据"},
                    ],
                },
            },
        ],
    )

    result = asyncio.run(search_prts("敌人数据", limit=1))

    assert result == {"totalhits": 1, "results": []}
