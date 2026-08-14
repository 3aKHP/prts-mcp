"""Tests for GITHUB_MIRRORS parsing in prts_mcp.sync.transport."""
from __future__ import annotations

import pytest

from prts_mcp.sync.transport import _parse_mirrors, _url_candidates


class TestParseMirrors:
    @pytest.mark.parametrize("value", [None, ""], ids=["unset", "empty"])
    def test_unset_or_empty_yields_no_mirrors(self, monkeypatch, value):
        if value is None:
            monkeypatch.delenv("GITHUB_MIRRORS", raising=False)
        else:
            monkeypatch.setenv("GITHUB_MIRRORS", value)
        assert _parse_mirrors() == []

    def test_mirror_without_trailing_slash_passes_through(self, monkeypatch):
        monkeypatch.setenv("GITHUB_MIRRORS", "https://ghproxy.net")
        assert _parse_mirrors() == ["https://ghproxy.net"]

    def test_single_trailing_slash_is_stripped(self, monkeypatch):
        monkeypatch.setenv("GITHUB_MIRRORS", "https://ghproxy.net/")
        assert _parse_mirrors() == ["https://ghproxy.net"]

    def test_all_trailing_slashes_are_stripped(self, monkeypatch):
        monkeypatch.setenv("GITHUB_MIRRORS", "https://ghproxy.net//")
        assert _parse_mirrors() == ["https://ghproxy.net"]

    def test_surrounding_whitespace_is_trimmed(self, monkeypatch):
        monkeypatch.setenv("GITHUB_MIRRORS", " https://a.example , https://b.example ")
        assert _parse_mirrors() == ["https://a.example", "https://b.example"]

    def test_whitespace_and_trailing_slashes_normalize_together(self, monkeypatch):
        monkeypatch.setenv("GITHUB_MIRRORS", " https://a.example/ , https://b.example// ")
        assert _parse_mirrors() == ["https://a.example", "https://b.example"]

    @pytest.mark.parametrize(
        "raw",
        ["https://a, ,https://b", "https://a,,https://b"],
        ids=["whitespace-only-entry", "empty-entry"],
    )
    def test_blank_entries_are_dropped(self, monkeypatch, raw):
        monkeypatch.setenv("GITHUB_MIRRORS", raw)
        assert _parse_mirrors() == ["https://a", "https://b"]

    def test_slash_only_entry_is_dropped_after_normalization(self, monkeypatch):
        monkeypatch.setenv("GITHUB_MIRRORS", "https://a,///,https://b")
        assert _parse_mirrors() == ["https://a", "https://b"]


def test_url_candidates_contain_no_doubled_slash(monkeypatch):
    monkeypatch.setenv("GITHUB_MIRRORS", "https://ghproxy.net//")
    url = "https://github.com/3aKHP/arknights-data-pipeline/releases/download/data-1/zh_CN.zip"
    candidates = _url_candidates(url)
    assert candidates == [
        url,
        f"https://ghproxy.net/{url}",
    ]
