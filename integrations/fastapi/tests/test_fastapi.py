from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.testclient import TestClient

from specbook_fastapi import TESTED_VERSION, add_specbook, get_specbook_html

from .helpers import INLINE_CODE, config_of, script_of


def page(**options: Any) -> str:
    app = FastAPI()

    @app.get("/page")
    def route() -> HTMLResponse:
        return get_specbook_html(**options)

    return TestClient(app).get("/page").text


class TestGetSpecbookHtml:
    def test_returns_html(self) -> None:
        response = get_specbook_html()
        assert response.status_code == 200
        assert response.media_type == "text/html"

    def test_defaults(self) -> None:
        html = page()
        assert config_of(html) == {"spec": "/openapi.json"}
        assert script_of(html) == ("https://ui.specbook.dev/v1/specbook.js", "")
        assert "<title>API docs</title>" in html

    def test_takes_every_option(self) -> None:
        html = page(
            openapi_url="/api/doc",
            title="Pets",
            default_env="live",
            base_url="https://api.test",
            cdn="npm",
            version="0.5.1",
            nonce="n0nce",
        )
        assert config_of(html) == {"spec": "/api/doc", "baseUrl": "https://api.test", "defaultEnv": "live"}
        assert script_of(html) == (
            "https://cdn.jsdelivr.net/npm/@specbook/ui@0.5.1/dist-viewer/specbook.js",
            ' nonce="n0nce"',
        )
        assert "<title>Pets</title>" in html

    def test_cdn_npm_loads_the_tested_release(self) -> None:
        assert script_of(page(cdn="npm"))[0] == (
            f"https://cdn.jsdelivr.net/npm/@specbook/ui@{TESTED_VERSION}/dist-viewer/specbook.js"
        )

    def test_src_beats_cdn_host_and_version(self) -> None:
        html = page(src="/specbook-viewer/specbook.js", cdn="npm", host="https://x.test", version="9")
        assert script_of(html)[0] == "/specbook-viewer/specbook.js"

    def test_escapes_what_an_attacker_could_use(self) -> None:
        html = page(openapi_url="/x</script><script>alert(1)</script>", title='</title><script>alert("t")</script>')
        assert INLINE_CODE.search(html) is None
        assert config_of(html)["spec"] == "/x</script><script>alert(1)</script>"
        assert "<title>&lt;/title&gt;&lt;script&gt;" in html

    def test_has_no_inline_script_that_runs(self) -> None:
        assert INLINE_CODE.search(page(nonce="x")) is None


class TestAddSpecbook:
    def test_serves_the_viewer_at_the_default_route(self) -> None:
        app = FastAPI(title="Pets API")
        add_specbook(app)
        response = TestClient(app).get("/specbook")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/html")
        assert config_of(response.text) == {"spec": "/openapi.json"}
        assert "<title>Pets API</title>" in response.text

    def test_returns_the_app(self) -> None:
        app = FastAPI()
        assert add_specbook(app) is app

    def test_hides_the_route_from_the_openapi_document(self) -> None:
        app = FastAPI()
        add_specbook(app, route="/docs")
        assert "/docs" not in TestClient(app).get("/openapi.json").json()["paths"]

    def test_can_show_the_route_in_the_document_when_asked(self) -> None:
        app = FastAPI()
        add_specbook(app, route="/docs", include_in_schema=True)
        assert "/docs" in TestClient(app).get("/openapi.json").json()["paths"]

    def test_replaces_fastapis_own_docs_page(self) -> None:
        app = FastAPI(docs_url=None, redoc_url=None)
        add_specbook(app, route="/docs")
        client = TestClient(app)
        assert config_of(client.get("/docs").text) == {"spec": "/openapi.json"}
        assert client.get("/redoc").status_code == 404

    def test_follows_a_custom_openapi_url(self) -> None:
        app = FastAPI(openapi_url="/api/v1/openapi.json")
        add_specbook(app)
        assert config_of(TestClient(app).get("/specbook").text)["spec"] == "/api/v1/openapi.json"

    def test_puts_the_roots_path_in_front_of_the_document_behind_a_prefix_or_a_proxy(self) -> None:
        app = FastAPI()
        add_specbook(app)
        client = TestClient(app, root_path="/service/")
        assert config_of(client.get("/specbook").text)["spec"] == "/service/openapi.json"

    def test_explicit_options_win(self) -> None:
        app = FastAPI(title="From the app")
        add_specbook(
            app,
            route="/ui",
            openapi_url="/elsewhere.json",
            title="Mine",
            default_env="live",
            base_url="https://api.test",
            nonce="abc",
        )
        html = TestClient(app).get("/ui").text
        assert config_of(html) == {"spec": "/elsewhere.json", "baseUrl": "https://api.test", "defaultEnv": "live"}
        assert script_of(html)[1] == ' nonce="abc"'
        assert "<title>Mine</title>" in html

    def test_a_sign_in_return_to_the_same_page_still_gets_the_page(self) -> None:
        app = FastAPI()
        add_specbook(app)
        response = TestClient(app).get("/specbook?code=abc&state=xyz")
        assert response.status_code == 200
        assert config_of(response.text) == {"spec": "/openapi.json"}

    def test_refuses_an_app_with_no_document_unless_told_where_it_is(self) -> None:
        app = FastAPI(openapi_url=None)
        with pytest.raises(ValueError, match="no OpenAPI document"):
            add_specbook(app)
        add_specbook(app, openapi_url="/somewhere-else.json")
        assert config_of(TestClient(app).get("/specbook").text)["spec"] == "/somewhere-else.json"
