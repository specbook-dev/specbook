# @specbook/core

The runner, mock engine, template engine and shared proxy behind Specbook: Storybook for APIs.

Part of [Specbook](https://github.com/specbook-dev/specbook), Storybook for APIs. See the repository for documentation.

## What to import

A project's request, flow, script and config files import from two places:

- `@specbook/core`: `defineConfig`, `sequence`, `c`, `script`, `withMock`, `request` and `defineOperation` (the last is what generated code uses), with the types they take and return (`InferControls`, `ScriptBody`, `RequestDef`, `Sequence`, `SpecbookConfig`, `AuthProfile`, ...).
- `@specbook/core/faker`: `faker`, typed from `@faker-js/faker`, which the project installs.

`@specbook/core/internal` is for Specbook's own packages (the CLI, the UI, the Vite plugin, the browser extension). It has no stability promise and may change in any release.

MIT licensed.
