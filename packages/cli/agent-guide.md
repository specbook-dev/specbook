# Specbook

> Specbook turns an OpenAPI spec into typed requests and flows that run as your API docs, as tests in CI, and as a monitor against production. Requests and flows are TypeScript files in the project's repo. The same files run in the terminal (`specbook test`), as one bundled `.mjs` file (`specbook bundle`), and in the browser (the docs UI, the QA portal and the "Try it" panel).

Use this file when you are asked to add or change requests, flows, checks or setup in a project that uses Specbook (`@specbook/cli`, `@specbook/core`). Needs Node 24.

Words used here: an **operation** is one endpoint of the spec. A **request** is a `.req.ts` file that calls one operation. A **flow** is a `.seq.ts` file that runs requests in order. A **profile** (the config's `auth`) applies credentials to a service's requests.

## Set up a project

1. `npm install --save-dev @specbook/cli @specbook/core`
2. `npx specbook init` creates `.specbook/specbook.config.ts`, `.specbook/environments/` and the `#api/*` import in `package.json`.
3. `npx specbook add <service> --spec <path or URL>` registers a spec and generates its types. A URL is downloaded to `openapi/` and recorded in `openapi/sources.json`. `add` also sets the service's address in `vars` (for example `petstoreUrl`; each environment can override it in `.specbook/environments/<env>.env`) and writes the credentials the spec's security asks for (see Auth and secrets).
4. `npx specbook check` validates specs, imports and environment files. `npx specbook generate` regenerates types; `test`, `dev` and `build` do it when they need to.
5. Typecheck. `init` adds `typescript` to `package.json` and writes a `tsconfig.json`, unless the project has them already. Run `npm install` to fetch it, then `npx tsc --noEmit` after every change. It is the only check a flow's wiring gets (see "Chain steps with types"). If the project had its own `tsconfig.json`, `init` left it alone: make sure its `include` has `"requests"`, `"sequences"`, `"scripts"`, `".specbook/*.ts"` and `".generated/*/index.ts"` (`".specbook"` alone skips the config file) and that `moduleResolution` is `"Bundler"`. A project without one gets:

   ```json
   {
     "compilerOptions": {
       "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "lib": ["ES2022", "DOM"],
       "strict": true, "skipLibCheck": true, "noEmit": true, "types": []
     },
     "include": ["requests", "sequences", "scripts", ".specbook/*.ts", ".generated/*/index.ts"]
   }
   ```

   `"types": []` keeps Node's globals out, so `Buffer`, `process` and `node:` imports fail here instead of later in the portal.

Never edit `.generated/`. Never put a secret's value in a file (see Auth and secrets).

## Auth and secrets

Read the spec's `securitySchemes`, and each operation's `security`, before you write the first request. Credentials go where the spec says: usually a header (`Authorization`, `X-API-Key`, `PLAID-SECRET`), sometimes a query parameter. Never put one in a request's `data`, even when the body has a field that looks right: the API ignores it and answers 401.

`specbook add` reads the spec's security and writes this for you: a secret for each scheme, an `auth` profile for every way the spec accepts (the cheapest to fill first), and `auth` on the service, a list with the default first. An operation uses the first listed profile that its `security` accepts (a profile says which scheme it satisfies with `scheme`), so a request names `auth:` only to override that. Check what it wrote against `securitySchemes`, and finish what its notes say: a header like `Plaid-Version` is a value that is not secret (put it in the secret's place). For a project that did not use `add`, write the same by hand. Here is a spec that wants two headers:

Here is a spec that wants two headers:

```ts
export default defineConfig({
  vars: { plaidUrl: 'https://sandbox.plaid.com' },
  secrets: { PLAID_CLIENT_ID: {}, PLAID_SECRET: {} },
  auth: {
    plaid: {
      apply: {
        headers: {
          'PLAID-CLIENT-ID': '{{secrets.PLAID_CLIENT_ID}}',
          'PLAID-SECRET': '{{secrets.PLAID_SECRET}}',
        },
      },
    },
  },
  services: { plaid: { spec: './openapi/plaid.yml', baseUrl: '{{plaidUrl}}', auth: 'plaid' } },
})
```

- `apply.headers` and `apply.query` take templates. A bearer token is `headers: { authorization: 'Bearer {{secrets.API_TOKEN}}' }`; a key in the query is `query: { api_key: '{{secrets.API_KEY}}' }`.
- A profile applies to every request of the service that names it. One request can pick another with `auth: 'name'`, or none with `auth: false` (a public operation, or the login call itself).
- A token you get by calling a login operation, and OAuth, are also profiles (`login`, `token`, `retryOn401`, `oauth`): see [Authorization](https://docs.specbook.dev/reference/authorization/).
- A run cannot sign in, because that needs a person and a browser. An OAuth API that has a client id and secret gets a profile ending in `-client`, which fetches its token with `<NAME>_CLIENT_ID` and `<NAME>_CLIENT_SECRET` from the environment. For a person's token, put one you issued in the profile's secret. Never write a client secret into a file.
- A secret's value comes from an environment variable of the same name or a gitignored `<env>.secrets.env` ([Environments and secrets](https://docs.specbook.dev/reference/environments-and-secrets/)). The `mock` environment needs no values. A real environment with a missing one exits 2 and names it.
- The mock answers 401 to an operation the spec marks as secured when the request carries no credential header, so a profile you forgot shows up in `specbook test` too. `npx specbook check` warns about a `{{secrets.NAME}}` that the config does not declare.

## Add a request

Put it at `requests/<service>/<name>.req.ts`. Import the operation from `#api/<service>` and export the request as the default:

```ts
import { FindPetsByStatus } from '#api/petstore'

export default FindPetsByStatus.request({
  name: 'Find pets by status',
  tags: ['smoke', 'monitor'],
  query: { status: '{{status}}' },
  init: { status: 'available' },
  capture: { pets: (res) => (res.status === 200 ? res.data : []) },
  assert: (res, { assert }) => {
    assert.is(res.status, 200, 'ok')
    if (res.status === 200) assert.ok(res.data.length > 0, 'returns at least one pet')
  },
})
```

- Find the operation first. Its export name is the spec's `operationId` in PascalCase (`getPetById` becomes `GetPetById`). Read
  `.generated/<service>/index.ts` (read only) or the spec to see them all; your editor completes `import { ... } from '#api/<service>'`.
- Fields: `name`, `tags`, `init` (default values), `path`, `query`, `headers`, `data` (the body), `capture`, `assert`, `auth`, `safe`, `timeoutMs`.
- Give every `{{name}}` the request uses a default in `init`. Then the request also runs on its own, and its `vars` are typed. A default is for running the request alone: in a flow, a value that comes from an earlier step arrives through the flow's `ctx` (see "Chain steps with types"), because a default also fills in silently when the chain breaks.
- `{{name}}` is filled from `init`, a flow's inputs, values captured by earlier steps, and the config's `vars`.
- Path, query and body are typed from the spec. Let the compiler tell you what is missing. It checks names and shapes, not string values: a field with a fixed set of values (an enum) accepts any string, so read the allowed ones in the spec.
- Credentials are not request fields: use a profile (see Auth and secrets).
- Add `tags: ['monitor']` to what should run against production.
- `safe: true` marks a POST that only reads (a search, a GraphQL query) so it is allowed in a `--safe` run.

## Asserts

- A request with no `assert` passes when the response is 2xx (the check is listed as `status is 2xx`). An `assert` replaces that check, so state the status you expect, even a 404.
- The helper is uvu's `assert` (`ok`, `is`, `equal`, `match`, `type`, `instance`, `throws`, with `not.` versions). Give every call a short label as its last argument: `assert.is(res.status, 200, 'order placed')`. The label is what the report shows.
- Check `res.status` before reading `res.data`: `if (res.status === 200) { ... }`. Then `res.data` has the type the spec gives that response.
- The second argument also gives `vars` (everything in scope plus this step's captures) and `req` (the request as sent).
- Every check runs and is reported. A failed one shows expected against received.

## Capture

`capture: { orderId: (res, vars) => (res.status === 200 ? res.data.id : undefined) }` keeps a value from the response for later steps. Return plain, JSON-serializable data. In a flow the value is `ctx.captured.orderId`, typed as whatever the function returns, and `{{orderId}}` in a later request.

## Pass whole values, not just ids

A placeholder that is the whole string gives the value itself, with its type: an object, an array, a number, a boolean. Capture the thing
and send it on:

- `capture: { category: (res) => (res.status === 200 ? res.data.category : undefined) }`, then `data: { category: '{{category}}' }` sends
  the object. An array of objects works the same way (`tags: '{{tags}}'`), and the whole body can be one placeholder: `data: '{{order}}'`.
- Inside a longer string the value becomes text, and an object or array becomes JSON: `name: 'copy of {{category.name}}'`.
- Reach into a value with dots and array positions: `{{pet.category.name}}`, `{{tags[0].id}}` (`{{tags.0.id}}` is the same), `{{grid[1][0]}}`.
  `{{tags.length}}` is the count. A name or position that is not there, such as `{{tags[5].id}}`, fails the step with `Missing variable`,
  and only a value's own fields are read (not `toString` or `constructor`). There are no expressions or filters: for anything computed,
  do it in `capture`, which is a function, and capture the shaped result.
- Whole objects belong in the JSON or form body. Path, query and header values are text: an array in a query repeats the key, but an
  object there is sent as "[object Object]". Use one of its fields (`{{pet.category.name}}`) or build the string in `capture`.
- A number stays a number. To send one as a string, capture `String(id)`.
- A name that does not exist fails the step with `Missing variable "{{name}}"`.

## Build a flow

Put it at `sequences/<name>.seq.ts`, importing the requests it uses:

```ts
import { c, sequence } from '@specbook/core'
import findPets from '../requests/petstore/find-pets.req'
import placeOrder from '../requests/petstore/place-order.req'

export default sequence({
  id: 'adopt-pet',
  title: 'Adopt a pet',
  description: 'Find available pets, pick one, order it.',
  tags: ['petstore', 'smoke'],
  inputs: {
    quantity: c.number({ default: 1, min: 1, description: 'How many to order.' }),
  },
})
  .step('Find available pets', findPets) // captures `pets`
  .input('Choose a pet', (ctx) => ({
    petId: c.select(ctx.captured.pets, {
      label: (p) => `${p.name} (#${p.id})`,
      value: (p) => p.id ?? 0,
      default: 0,
    }),
  }))
  .step('Place order', (ctx) =>
    placeOrder.with({ data: { petId: ctx.inputs.petId, quantity: ctx.inputs.quantity } }),
  )
```

- `.step(name, request)`; the second argument may be `(ctx) => request`, where `ctx` has `inputs`, `captured`, `vars` and `env`.
- `request.with({ ... })` changes a request for one step (for example its `assert`, or the values it sends).
- Also: `.input(name, ctx => controls)` asks a person for values, `.each(name, items, make)` repeats a request per item, `.check(name, fn)` asserts on the flow's state, `.use(otherFlow)` includes another flow.
- Controls are `c.number`, `c.text`, `c.select`, `c.multiselect`, `c.boolean`, `c.date`, `c.object`, `c.array`. A flow also runs unattended in CI and as a monitor, so every input and every `.input()` control needs a default that makes sense with nobody to ask.
- Several values for one thing (travelers, line items): `c.object({ name: c.text(...), gender: c.select([...]) }, { label: 'Traveler 1' })` is a group, and `c.array(item, { min: 1, max: 10, label: 'Travelers' })` is a list whose length a person sets. The form shows groups with the same fields as one table with a row for each, so declare them with one helper (`const traveler = (label: string) => c.object({ ... }, { label })`). A list with no value starts at `min` items, each made from its own defaults. Read them as `{{traveler1.name}}` or `{{travelers[0].name}}`, or `ctx.inputs.travelers` (`.each(name, ctx => ctx.inputs.travelers, ...)` makes a request for each). A flat key with a dot (`'traveler1.name'`) is not a path: use a group.
- For generated data: `import { faker } from '@specbook/core/faker'` and use it in a default, for example `c.text({ default: () => faker.person.fullName() })`. It is typed, and `specbook init` adds `@faker-js/faker` to `package.json` (`npm install` fetches it). A `{{faker.person.firstName}}` placeholder (`faker.<module>.<method>`, no arguments) also works in a field.
- Each step is also a request you can run alone.

### Chain steps with types, not strings

Values move between steps by name, and there are two ways to write the name:

- A template string: one request has `capture: { orderId: ... }`, the next has `path: { orderId: '{{orderId}}' }`. Every field accepts any string, so `'{{ordrId}}'` compiles and fails only when the step runs. Worse, if that request has `init: { orderId: 5001 }`, a renamed capture does not fail at all: the step quietly sends 5001, and on the mock it can still pass.
- Typed code in the flow: `.step(name, (ctx) => request.with({ ... }))`. `ctx.captured.orderId` has the type the capture returned and `ctx.inputs.quantity` the type of its control, so a renamed or mistyped one is a compile error. Put the value in the `data`, `path` or `query` of `.with`: they are typed from the spec, so a wrong field name or type is an error too.

```ts
  .step('Place order', placeOrder) // captures `orderId`
  .step('Get order', (ctx) => getOrder.with({ path: { orderId: ctx.captured.orderId } }))
```

- Use `{{...}}` for config `vars`, `{{secrets.*}}`, `{{faker.*}}` and a request's own `init` defaults. Between steps, use `ctx`.
- `.with({ vars: { name: ... } })` is checked only for names the request lists in `init`; any other name is accepted. Prefer `data`, `path` or `query`.
- Every name lives in one scope, and a later layer beats an earlier one: config `vars`, `init`, flow inputs, captures, `.with({ vars })`, `--var`. A capture named like an `init` key replaces it. That is how a bare `{{name}}` finds an earlier step's value, and why renaming one end breaks it without a sound.
- Prove the chain with a `.check` step, so a stale value fails instead of passing: capture what the later response says, then compare it with what the earlier step captured: `.check('Same order', (ctx, { assert }) => assert.is(ctx.captured.readBackId, ctx.captured.orderId, 'the order read back is the one placed'))`. `.with({ assert })` replaces the request's own asserts for that step, so use it only when you mean to.
- Finish with `npx tsc --noEmit`. `specbook check` reads requests, never flows, so the compiler is the only check a flow's wiring gets. Fix the cause of a type error (a wrong name, or a missing check on `res.status`) rather than silencing it with `any` or `as`.

### Recipe: list, check, pick, act

For "fetch the products, assert there is at least one, pick one, add it to the cart with a quantity from the inputs":

1. `requests/shop/list-products.req.ts`: the list operation, `assert` that `res.data.length > 0`, and capture the list:
   `capture: { products: (res) => (res.status === 200 ? res.data : []) }`.
2. `requests/shop/add-to-cart.req.ts`: the add operation with `init: { productId: 1, quantity: 1 }` and
   `data: { productId: '{{productId}}', quantity: '{{quantity}}' }`, so it also runs alone.
3. `sequences/add-to-cart.seq.ts`: `inputs: { quantity: c.number({ default: 1, min: 1 }) }`, then
   `.step('List products', listProducts)`, `.input('Choose a product', (ctx) => ({ productId: c.select(ctx.captured.products, { label: (p) => p.name, value: (p) => p.id, default: 0 }) }))`,
   then `.step('Add to cart', (ctx) => addToCart.with({ data: { productId: ctx.inputs.productId, quantity: ctx.inputs.quantity } }))`.
4. Run `npx tsc --noEmit`, then `npx specbook test --grep "Add to cart"`, and `--input quantity=3` to try another value.

Capture is declared on the request that makes the response, and the flow reads it as `ctx.captured.<name>`. Pick the way to choose:
- To take the first item with nobody asked, capture it in the list request (`capture: { productId: (res) => (res.status === 200 ? res.data[0]?.id : undefined) }`),
  leave out `.input()`, and pass `ctx.captured.productId` to the next step in `.with({ data })`.
- To let a person choose in the portal, use `.input()` with `c.select`, as above. Automation is not asked and takes the default, the first item.

## Add a script

A step that is code, not a request: a payment SDK that needs a browser, or a library that runs anywhere. It has typed inputs,
and what its body returns is its typed output, like a request's response. The contract is `scripts/<name>.script.ts`, a flow
imports it, and a body that needs a page goes in `scripts/<name>.browser.ts`, which exports it as `run` and is loaded when the
step runs:

```ts
// scripts/approve.script.ts
import { c, type InferControls, script, withMock } from '@specbook/core'

export const inputs = { amount: c.number({ default: 25, min: 1 }), clientToken: c.text() }
export type Inputs = InferControls<typeof inputs>

export default withMock(
  script({
    id: 'approve-payment',
    name: 'Approve a payment', // optional: the title in the catalog, else the id
    runtime: 'browser', // 'isomorphic' (the default), 'browser' or 'node'
    inputs,
    load: () => import('./approve.browser'),
  }),
  // what the mock environment answers, from the inputs: it must have the shape the body returns
  ({ inputs }) => ({ nonce: `fake-${inputs.amount}` }),
)
```

```ts
// scripts/approve.browser.ts
import type { ScriptBody } from '@specbook/core'
import type { Inputs } from './approve.script'

// what the body returns is the script's output; annotate it when a field has several possible values
export type Output = { nonce: string }

export const run: ScriptBody<Inputs, Output> = async ({ amount, clientToken }, h) => {
  const sdk = await h.loadScript('https://sdk.example/v1.js', { global: 'Pay' })
  const el = await h.mount() // a container in the step's row: give it to the SDK, never a selector
  // ... render the SDK's button into el, wait for the person, listen to h.signal for Stop
  return { nonce: 'a-real-nonce' }
}
```

```ts
// in a flow: the output is captured, so ctx.captured.nonce is a typed string
.step('Approve', approve.with({ inputs: { clientToken: '{{clientToken}}' } }))
.step('Pay', (ctx) => pay.with({ data: { nonce: ctx.captured.nonce } }))
```

- A small script that works anywhere keeps its body in the one file with `run: async (inputs, h) => ({ ... })` in place of `load`.
  `run` and `load` are alternatives. Every script is wrapped in `withMock`, which returns what the `mock` environment answers:
  without it the step fails on `mock` and `specbook check` warns. A script runs anywhere unless it says `runtime: 'browser'` or `'node'`. `specbook check` warns
  about a browser script with an inline body. The checks go in the contract's `assert`, which also runs on `mock`.
- `.with({ inputs })` takes a value, or a `{{placeholder}}` for a flow input, a config var or an earlier capture. Nothing is
  picked up by name, and a control with no default that is not given is an error. A script is never handed `{{secrets.*}}`:
  capture what it needs from an earlier request.
- The body is given `h.fetch`, `h.loadScript(url, { global, integrity, once })`, `h.mount()`, `h.signal`, `h.log`, `h.env`,
  `h.vars` and `h.runtime`. `h.loadScript` loads a file once per address by default (for the page's life, or one test run in
  node); `once: false` loads it again on that call. In a page `h.fetch` goes through the browser extension for a site that needs it. `h.signal` ends on Stop
  or when the script's `timeoutMs` passes; in node the run's `--timeout` applies when the script names none.
- A flow whose scripts need a browser is skipped as a whole, and counts as passed, in `specbook test` and a bundle on a real
  environment. On `mock` every script answers with its `withMock` (the body never runs), so such a flow is still checked in CI.
  A flow that needs node is skipped in the portal. The bundle leaves `*.browser.ts` files out.
- A script that loads another site's SDK or widget needs that site allowed by the page that serves the portal: `script-src` for
  its file, `frame-src` for a frame it opens, `connect-src` for what it calls. Nothing is fetched until the step runs, and never on
  `mock`. The worked example is Cloudflare Turnstile with its published test keys, which need no account and no secret: a script
  that shows the widget and returns its token, then a request that verifies the token. Payment SDKs such as PayPal, Braintree and
  Stripe fit the same way, with a value from your server (a client token, a payment intent) captured by an earlier request step.
- A script is not used in `.each()`. It also runs on its own, as a flow of one step: `specbook test` runs `scripts/**/*.script.ts`
  (`--input name=value` sets its inputs), the portal lists it under Scripts with a form built from its inputs, `name`, `description`
  and `tags` are what the catalog shows and `--tag` selects by, and a page opens it with `data-specbook-script="<id>"`.
  Run `npx tsc --noEmit` and `npx specbook check` after writing one.

## Mocks

The `mock` environment (the default for `specbook test` and the UI) answers from the spec's examples with the request's values filled in, and needs no server and no secret values. A status the spec gives several answers for (a `oneOf`, or named examples) keeps all of them in its example file; `res.respond(status, data, 'VariantName')` picks one. When a check needs data the example lacks, wrap the request in `withMock` from `@specbook/core`; the file's one export stays the default:

```ts
export default withMock(GetOrderById.request({ /* ... */ }), (req, res) => {
  if (res.status === 200) res.data.status = 'placed'
})
```

## Run it

- Before you finish: `npx tsc --noEmit`, `npx specbook check`, `npx specbook test`. A green test run does not prove a flow is wired to the right names; the compiler does.
- `npx specbook test` runs everything against mock data. `--env staging` runs against a real environment. `--tag monitor`, `--grep <re>`, `--list`, `--input name=value`, `--retries 1` (a pass on retry is reported as flaky), `--timeout <ms>`.
- It runs every request on its own as well as each flow, with the request's `init` defaults. A request that only makes sense after an earlier step passes on the mock with stand-in defaults but fails alone on a real environment, so tag the flow and the requests that work alone, and select them with `--tag`.
- Against production always pass `--safe`: a request that is not a GET, HEAD or OPTIONS is refused.
- Exit codes: 0 passed, 1 a flow failed or errored, 2 it could not run (missing secrets, a missing spec), 3 usage.
- `npx specbook dev` opens the UI; `npx specbook build --minimal` publishes a small portal of only the project's requests and flows for QA; `npx specbook bundle` writes one `.mjs` that runs with just node, for CI and ops.

## Write isomorphic code

Requests and flows run in three places: node (`specbook test`), the single-file bundle (`specbook bundle`, run with just node) and the
browser (the docs UI, the QA portal and "Try it"). Everything they import must work in all three. A build and a green `specbook test`
do not prove it: a request that needs Node builds cleanly and passes in node, and only fails when someone opens it in the portal.

- Use what is already there: `fetch` (global), `@specbook/core` (the `c` controls; `assert` arrives as the argument of an `assert` or `check` callback), `faker` from `@specbook/core/faker` and
  the language itself (`Date`, `Intl`, `URL`, `btoa`, `crypto.randomUUID()`). Prefer no new dependencies. A library such as lodash does
  work in the browser, but it adds a lot of weight to the portal and the bundle for something a few lines of code do.
- Do not use `Buffer`: in the browser it is "Buffer is not defined". Use `btoa`, `Uint8Array`, `TextEncoder` and `TextDecoder`.
- Do not use Node built-ins (`fs`, `path`, `os`, `net`, `child_process`): in the browser the first call throws "externalized for browser
  compatibility". For a file a request uploads, use the request's file `data`, which is embedded in the portal and the bundle.
- Do not read `process.env`. In the browser it is empty and silently `undefined`, so a request that reads a secret from it sends nothing.
  Use `{{secrets.NAME}}` for secrets and the config's `vars` (`{{name}}`) for everything else.
- Do not use native addons, packages that `require()` a computed path, or packages that read their own files at run time.
- If a new package is unavoidable, it must be plain ESM JavaScript with no install scripts and no Node built-ins. Prove it three ways:
  `npx specbook test`, `npx specbook bundle`, and `npx specbook build --minimal` followed by running the request in the portal.
- Code that can only run in a browser (a payment SDK, anything that needs `document`) is the one exception, and it goes in a
  script body, never in a request or a flow (see "Add a script"). Nothing outside a `scripts/*.browser.ts` file may touch the DOM.
- `specbook bundle --external <package>` is not a way around this. It leaves the import for node to resolve and a browser cannot, so a
  request that needs it will not run in the portal. Do not use it for requests or flows. There is no node-only exception: if a request
  cannot be written with `fetch` and plain code, tell the user instead of adding a Node-only dependency.

## Notes beside the code (optional)

Markdown next to what it describes is shown in the UI: `requests/<service>/<Operation>/README.md` for an operation, `<name>.req.md` beside a request, `<name>.seq.md` beside a flow. The Docs tab shows the spec's parameters, request body and responses below the page; `<!-- specbook: params -->` (also `path`, `query`, `headers`, `body`, `responses`) on a line of its own puts one where you want it. Field descriptions come from the spec, not from the page.
