from __future__ import annotations

import re


def strip_wikitext(text: str) -> str:
    """Remove common wikitext markup and return plain text."""
    # Remove {{template}} blocks (non-greedy, single-level)
    text = re.sub(r"\{\{[^}]*\}\}", "", text)
    # Remove [[File:...]] / [[文件:...]] image links
    text = re.sub(r"\[\[(File|文件|Image|图像):[^\]]*\]\]", "", text)
    # Convert [[link|display]] -> display, [[link]] -> link
    text = re.sub(r"\[\[[^|\]]*\|([^\]]+)\]\]", r"\1", text)
    text = re.sub(r"\[\[([^\]]+)\]\]", r"\1", text)
    # Remove HTML tags
    text = re.sub(r"<[^>]+>", "", text)
    # Remove category links
    text = re.sub(r"\[\[(Category|分类):[^\]]*\]\]", "", text)
    # Collapse multiple blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()
