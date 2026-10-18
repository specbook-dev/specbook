# specbook-fastapi

Serves the [Specbook UI](https://ui.specbook.dev) for your FastAPI app's OpenAPI document. It reads the document in the browser and lets a visitor send each request: against **mock** responses built from the document's examples, or **live** against your API. It runs on your app's own origin, so there is no CORS to configure and the visitor's cookies are sent.

<img src="https://raw.githubusercontent.com/specbook-dev/specbook/main/.github/screenshot-pair.png" alt="Specbook with the Petstore spec open on a laptop and on a phone" width="840" />

See the [Specbook docs](https://docs.specbook.dev) for what else it can do: requests with checks, flows, tests that run in CI, and a portal for QA.

The package only returns an HTML page that loads the viewer, so it adds nothing to your app but one route.

## Installation

```bash
pip install specbook-fastapi
# or
uv add specbook-fastapi
```

Python 3.10 or newer, and FastAPI.

## Usage

Serve the viewer at `/specbook` for the app's own OpenAPI document:

```python
from fastapi import FastAPI
from specbook_fastapi import add_specbook

app = FastAPI()
add_specbook(app)  # the viewer is at /specbook
```

To use it instead of FastAPI's own docs page, turn that off and take its route:

```python
app = FastAPI(docs_url=None, redoc_url=None)
add_specbook(app, route="/docs")
```

The document's address and the page title come from the app (`app.openapi_url`, with the request's `root_path` in front of it, so it works behind a prefix or a proxy, and `app.title`). The route is left out of the OpenAPI document.

### Your own route

`get_specbook_html` returns an `HTMLResponse`, for when you want to set the route up yourself:

```python
from fastapi import FastAPI
from specbook_fastapi import get_specbook_html

app = FastAPI(docs_url=None)


@app.get("/docs", include_in_schema=False)
async def docs():
    return get_specbook_html(openapi_url=app.openapi_url, title=f"{app.title} docs", default_env="live")
```

## Options

`add_specbook` takes `route` and `include_in_schema`, and passes every other keyword argument on to `get_specbook_html`.

| Option        | Type                    | Default                | Description                                                                                                                      |
| ------------- | ----------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `openapi_url` | `str`                   | `/openapi.json`        | The OpenAPI document. A relative address is resolved against the page. `add_specbook` takes it from the app.                     |
| `title`       | `str`                   | `API docs`             | The page title. It is HTML-escaped. `add_specbook` takes it from the app.                                                        |
| `default_env` | `str`                   | `mock`                 | The environment shown first: `mock`, `live`, or the name of a server in the document.                                            |
| `base_url`    | `str`                   | the page's own origin  | Where live requests go when the document lists no server.                                                                        |
| `cdn`         | `"specbook"` \| `"npm"` | `"specbook"`           | Where the viewer is loaded from: the stable `v1` channel at `ui.specbook.dev`, or `@specbook/ui` on jsDelivr.                    |
| `version`     | `str`                   | `v1` / tested release  | With `specbook`, the channel. With `npm`, a version or range of `@specbook/ui`. The default is the release this was tested with. |
| `host`        | `str`                   | the host of `cdn`      | The host, for example `https://unpkg.com` or an internal mirror.                                                                 |
| `src`         | `str`                   |                        | The full address of `specbook.js`, for a copy you serve yourself. It overrides `cdn`, `version` and `host`.                      |
| `nonce`       | `str`                   |                        | A [CSP nonce](https://developer.mozilla.org/docs/Web/HTTP/CSP#nonces) for the viewer's script.                                   |

The viewer's own settings (`default_env`, the page title, the Content-Security-Policy it needs) are described in the [embed reference](https://docs.specbook.dev/reference/embed/).

The `specbook` host is the newest deployed build of the `v1` line, so fixes reach your app without a new release of this package. A breaking change to the viewer would ship as `/v2/`. The `npm` host is an immutable release of `@specbook/ui`; pin `version` to hold it still.

## Content-Security-Policy

The page has no inline script. The JSON that configures the viewer is data, so it needs no nonce, and the one module script takes `nonce` when your policy uses nonces.

| Where the viewer comes from | The policy needs                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------- |
| A copy you serve (`src`)    | `script-src 'self'` and `worker-src 'self'`                                           |
| `ui.specbook.dev`           | that host in `script-src`, `style-src` and `worker-src`, plus `blob:` in `worker-src` |
| jsDelivr (`cdn="npm"`)      | `https://cdn.jsdelivr.net` in the same three directives, plus `blob:` in `worker-src` |

## Privacy

The viewer runs no analytics or tracking script, and your document and your API's responses stay in the visitor's browser; nothing is sent to Specbook. Loading the script from `ui.specbook.dev` or jsDelivr means that host sees the visitor's IP address and the file requests, as any CDN does; [serve the viewer yourself](#serving-the-viewer-yourself) to avoid that.

The overview shows a small "Powered by Specbook" link. It points to `docs.specbook.dev` with your site's hostname in the address, and the Specbook docs site uses Cloudflare Web Analytics.

## Serving the viewer yourself

Every Specbook release carries the viewer's files as `specbook-viewer-<version>.zip` (MIT, with its third-party licence notices) on its [GitHub release](https://github.com/specbook-dev/specbook/releases), and `@specbook/ui` on npm ships the same files in `dist-viewer/`. Unpack them into a folder, serve it from your app and point `src` at it, so nothing is loaded from another host:

```python
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from specbook_fastapi import add_specbook

app = FastAPI(docs_url=None, redoc_url=None)
app.mount("/specbook-viewer", StaticFiles(directory="specbook-viewer"), name="specbook-viewer")
add_specbook(app, route="/docs", src="/specbook-viewer/specbook.js")
```

## Author

Maintained by the [Specbook](https://github.com/specbook-dev/specbook) team. Issues are welcome at [specbook-dev/specbook](https://github.com/specbook-dev/specbook/issues).

## License

MIT
