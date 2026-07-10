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
    def __init__(self, payloads: list[dict[str, Any] | Exception]) -> None:
        self.payloads = payloads
        self.requests: list[dict[str, Any]] = []

    async def get(self, _url: str, params: dict[str, Any]) -> FakeResponse:
        self.requests.append(params)
        payload = self.payloads.pop(0)
        if isinstance(payload, Exception):
            raise payload
        return FakeResponse(payload)


async def _no_rate_limit() -> None:
    return None


def _patch_client(
    monkeypatch: pytest.MonkeyPatch,
    payloads: list[dict[str, Any] | Exception],
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
                    "search": [{"title": "阿米亚", "snippet": "# redirect [[阿米娅]]"}],
                },
            },
            {"query": {"redirects": [{"from": "阿米亚", "to": "阿米娅"}]}},
        ],
    )

    assert asyncio.run(search_prts("阿米亚", limit=1)) == {
        "totalhits": 1,
        "results": [{"title": "阿米娅", "snippet": "阿米娅"}],
    }
    assert client.requests[0]["srprop"] == "snippet|redirecttitle"
    assert client.requests[1]["redirects"] == "1"
    assert client.requests[1]["titles"] == "阿米亚"


def test_search_prts_keeps_result_when_redirect_lookup_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_client(
        monkeypatch,
        [
            {
                "query": {
                    "searchinfo": {"totalhits": 1},
                    "search": [{"title": "阿米亚", "snippet": "# redirect [[阿米娅]]"}],
                },
            },
            RuntimeError("redirect lookup failed"),
        ],
    )

    assert asyncio.run(search_prts("阿米亚", limit=1)) == {
        "totalhits": 1,
        "results": [{"title": "阿米亚", "snippet": "阿米娅"}],
    }


def test_search_prts_filters_technical_pages_and_keeps_totalhits(
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

    assert asyncio.run(search_prts("凯尔希", limit=2)) == {
        "totalhits": 2,
        "results": [{"title": "凯尔希", "snippet": "罗德岛医生。"}],
    }


def test_search_prts_can_keep_technical_pages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_client(
        monkeypatch,
        [
            {
                "query": {
                    "searchinfo": {"totalhits": 1},
                    "search": [{"title": "敌人数据/module", "snippet": "技术数据"}],
                },
            },
        ],
    )

    assert asyncio.run(search_prts("敌人数据", limit=1, filter_technical=False)) == {
        "totalhits": 1,
        "results": [{"title": "敌人数据/module", "snippet": "技术数据"}],
    }
