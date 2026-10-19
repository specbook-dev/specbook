"""The page that loads the Specbook viewer: pure functions, no FastAPI needed."""

from __future__ import annotations

import html
import json
from typing import Any, Literal

Cdn = Literal["specbook", "npm"]

#: The `@specbook/ui` release the `npm` host loads unless `version` is given.
TESTED_VERSION = "0.6.1"

SPECBOOK_HOST = "https://ui.specbook.dev"
NPM_HOST = "https://cdn.jsdelivr.net/npm"
DEFAULT_CHANNEL = "v1"


def escape_html(value: str) -> str:
    """Escape text for an HTML body or a quoted attribute."""
    return html.escape(value, quote=True)


def json_for_script(value: Any) -> str:
    """JSON that is safe inside a `<script>` element: nothing in it can close the element or start a comment."""
    return (
        json.dumps(value, separators=(",", ":"), ensure_ascii=False)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace(" ", "\\u2028")
        .replace(" ", "\\u2029")
    )


def script_url(
    *,
    cdn: Cdn = "specbook",
    host: str | None = None,
    version: str | None = None,
    src: str | None = None,
) -> str:
    """The address of `specbook.js`. `src` wins; otherwise `cdn` picks the host and `version` the release."""
    if src is not None:
        return src
    if cdn == "npm":
        base = (host or NPM_HOST).rstrip("/")
        return f"{base}/@specbook/ui@{version or TESTED_VERSION}/dist-viewer/specbook.js"
    if cdn == "specbook":
        base = (host or SPECBOOK_HOST).rstrip("/")
        return f"{base}/{version or DEFAULT_CHANNEL}/specbook.js"
    raise ValueError(f"cdn must be 'specbook' or 'npm', not {cdn!r}")


def render_embed(
    *,
    spec: str,
    script: str,
    base_url: str | None = None,
    default_env: str | None = None,
    nonce: str | None = None,
) -> str:
    """The three elements the viewer needs: its container, its configuration as data, and its module script."""
    config: dict[str, str] = {"spec": spec}
    if base_url is not None:
        config["baseUrl"] = base_url
    if default_env is not None:
        config["defaultEnv"] = default_env
    nonce_attr = "" if nonce is None else f' nonce="{escape_html(nonce)}"'
    return "\n".join(
        [
            '<div id="app"></div>',
            f'<script type="application/json" id="specbook-config">{json_for_script(config)}</script>',
            f'<script type="module" src="{escape_html(script)}"{nonce_attr}></script>',
        ]
    )


def render_page(*, title: str, embed: str) -> str:
    """A whole page around the embed. The viewer takes over the page, so it gets one of its own."""
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{escape_html(title)}</title>
  </head>
  <body>
{embed}
  </body>
</html>
"""
