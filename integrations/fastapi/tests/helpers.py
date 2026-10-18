import json
import re

CONFIG = re.compile(r'<script type="application/json" id="specbook-config">(.*?)</script>', re.S)
MODULE = re.compile(r'<script type="module" src="([^"]*)"([^>]*)></script>')
INLINE_CODE = re.compile(r"<script(?![^>]*\bsrc=)(?![^>]*application/json)[^>]*>")


def config_of(page: str) -> dict[str, str]:
    """The viewer's configuration as the page carries it."""
    match = CONFIG.search(page)
    assert match, "the page has no specbook-config element"
    config: dict[str, str] = json.loads(match.group(1))
    return config


def script_of(page: str) -> tuple[str, str]:
    """The address and the other attributes of the viewer's module script."""
    match = MODULE.search(page)
    assert match, "the page has no module script"
    return match.group(1), match.group(2)
