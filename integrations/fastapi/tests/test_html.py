import json

import pytest

from specbook_fastapi._html import (
    TESTED_VERSION,
    escape_html,
    json_for_script,
    render_embed,
    render_page,
    script_url,
)


class TestScriptUrl:
    def test_defaults_to_the_v1_channel_at_ui_specbook_dev(self) -> None:
        assert script_url() == "https://ui.specbook.dev/v1/specbook.js"
        assert script_url(cdn="specbook") == "https://ui.specbook.dev/v1/specbook.js"

    def test_takes_a_channel_and_a_mirror_for_the_host(self) -> None:
        assert script_url(version="v2") == "https://ui.specbook.dev/v2/specbook.js"
        assert script_url(host="https://mirror.test/") == "https://mirror.test/v1/specbook.js"

    def test_loads_specbook_ui_from_jsdelivr_with_cdn_npm_at_the_tested_version(self) -> None:
        assert TESTED_VERSION.count(".") == 2 and all(p.isdigit() for p in TESTED_VERSION.split("."))
        assert script_url(cdn="npm") == (
            f"https://cdn.jsdelivr.net/npm/@specbook/ui@{TESTED_VERSION}/dist-viewer/specbook.js"
        )

    def test_takes_an_npm_version_a_range_and_another_npm_host(self) -> None:
        assert script_url(cdn="npm", version="0.5.1") == (
            "https://cdn.jsdelivr.net/npm/@specbook/ui@0.5.1/dist-viewer/specbook.js"
        )
        assert script_url(cdn="npm", version="latest", host="https://unpkg.com//") == (
            "https://unpkg.com/@specbook/ui@latest/dist-viewer/specbook.js"
        )

    def test_src_beats_everything(self) -> None:
        assert (
            script_url(src="/specbook/specbook.js", cdn="npm", host="https://x.test", version="9")
            == "/specbook/specbook.js"
        )

    def test_refuses_an_unknown_cdn(self) -> None:
        with pytest.raises(ValueError, match="cdn must be"):
            script_url(cdn="elsewhere")  # type: ignore[arg-type]


class TestEscaping:
    def test_escapes_html_in_text_and_attributes(self) -> None:
        assert escape_html("""<a href="x">'&'</a>""") == "&lt;a href=&quot;x&quot;&gt;&#x27;&amp;&#x27;&lt;/a&gt;"

    def test_json_for_script_cannot_close_the_element_or_start_a_comment(self) -> None:
        out = json_for_script({"spec": "/a</script><!--&  "})
        for forbidden in ("<", ">", "&", " ", " "):
            assert forbidden not in out
        # and it is still the same value once read back
        assert json.loads(out) == {"spec": "/a</script><!--&  "}

    def test_json_for_script_is_compact(self) -> None:
        assert json_for_script({"spec": "/x", "defaultEnv": "live"}) == '{"spec":"/x","defaultEnv":"live"}'


class TestRender:
    def test_embed_has_the_container_the_data_and_the_script(self) -> None:
        embed = render_embed(spec="/openapi.json", script="https://ui.specbook.dev/v1/specbook.js")
        assert embed.splitlines() == [
            '<div id="app"></div>',
            '<script type="application/json" id="specbook-config">{"spec":"/openapi.json"}</script>',
            '<script type="module" src="https://ui.specbook.dev/v1/specbook.js"></script>',
        ]

    def test_embed_names_base_url_and_default_env_only_when_given(self) -> None:
        embed = render_embed(spec="/d", script="/s.js", base_url="https://api.test", default_env="live")
        assert '{"spec":"/d","baseUrl":"https://api.test","defaultEnv":"live"}' in embed

    def test_nonce_goes_on_the_module_script_and_is_escaped(self) -> None:
        embed = render_embed(spec="/d", script="/s.js", nonce='ab"c')
        assert '<script type="module" src="/s.js" nonce="ab&quot;c"></script>' in embed
        assert 'nonce="' not in embed.split('<script type="module"')[0]

    def test_script_address_is_escaped(self) -> None:
        embed = render_embed(spec="/d", script='/s.js?a=1&b="2"')
        assert 'src="/s.js?a=1&amp;b=&quot;2&quot;"' in embed

    def test_page_escapes_the_title_and_wraps_the_embed(self) -> None:
        page = render_page(title="<b>Pets & co</b>", embed="<!--embed-->")
        assert "<title>&lt;b&gt;Pets &amp; co&lt;/b&gt;</title>" in page
        assert page.startswith("<!doctype html>")
        assert "<body>\n<!--embed-->\n  </body>" in page
