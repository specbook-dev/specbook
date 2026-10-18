"""Serve the Specbook API viewer from a FastAPI app.

from fastapi import FastAPI
from specbook_fastapi import add_specbook

app = FastAPI(docs_url=None, redoc_url=None)
add_specbook(app, route="/docs")
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _version
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse

from ._html import TESTED_VERSION, Cdn, render_embed, render_page, script_url

try:
    __version__ = _version("specbook-fastapi")
except PackageNotFoundError:  # running from a source checkout that is not installed
    __version__ = "0.0.0"

__all__ = ["TESTED_VERSION", "add_specbook", "get_specbook_html", "__version__"]


def get_specbook_html(
    *,
    openapi_url: str = "/openapi.json",
    title: str = "API docs",
    default_env: str | None = None,
    base_url: str | None = None,
    cdn: Cdn = "specbook",
    version: str | None = None,
    host: str | None = None,
    src: str | None = None,
    nonce: str | None = None,
) -> HTMLResponse:
    """A page that loads the Specbook viewer for the OpenAPI document at `openapi_url`.

    Args:
        openapi_url: The OpenAPI document. A relative address is resolved against the page.
        title: The page title. It is HTML-escaped.
        default_env: The environment shown first: `mock` (the viewer's default), `live`, or the name of a server in the
            document.
        base_url: Where live requests go when the document lists no server. Default: the page's own origin.
        cdn: Where the viewer is loaded from: `specbook` (the stable `v1` channel at ui.specbook.dev) or `npm`
            (`@specbook/ui` on jsDelivr).
        version: With `specbook`, the channel (default `v1`). With `npm`, a version or range of `@specbook/ui`
            (default: the release this package was tested with).
        host: The host to load from instead of the one `cdn` names, for example `https://unpkg.com` or an internal
            mirror.
        src: The full address of `specbook.js`, for a copy you serve yourself. It overrides `cdn`, `version` and `host`.
        nonce: A CSP nonce for the viewer's script.
    """
    embed = render_embed(
        spec=openapi_url,
        script=script_url(cdn=cdn, host=host, version=version, src=src),
        base_url=base_url,
        default_env=default_env,
        nonce=nonce,
    )
    return HTMLResponse(render_page(title=title, embed=embed))


def add_specbook(
    app: FastAPI,
    *,
    route: str = "/specbook",
    include_in_schema: bool = False,
    **options: Any,
) -> FastAPI:
    """Serve the viewer at `route` for the app's own OpenAPI document.

    The document's address and the page title come from the app (`app.openapi_url`, with the request's `root_path` in
    front of it, so it works behind a prefix or a proxy, and `app.title`) unless you pass `openapi_url` or `title`. Any
    other option is passed on to `get_specbook_html`. To replace FastAPI's own docs page, turn it off and take its
    route::

        app = FastAPI(docs_url=None, redoc_url=None)
        add_specbook(app, route="/docs")
    """
    if "openapi_url" not in options and app.openapi_url is None:
        raise ValueError(
            "The app has no OpenAPI document (openapi_url is None). Pass openapi_url=... or enable the document."
        )

    @app.get(route, include_in_schema=include_in_schema, response_class=HTMLResponse)
    async def specbook_docs(request: Request) -> HTMLResponse:
        page = dict(options)
        if "openapi_url" not in page:
            root_path = request.scope.get("root_path", "").rstrip("/")
            page["openapi_url"] = f"{root_path}{app.openapi_url}"
        page.setdefault("title", app.title)
        return get_specbook_html(**page)

    return app
