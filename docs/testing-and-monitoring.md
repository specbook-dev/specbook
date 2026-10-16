# Testing and monitoring

A developer explores one or more APIs and writes a request or a flow once.

- A **request** is one call to one operation. It passes when the call works (a 2xx response), and you can add
  assertions of your own: "get pet 1 returns 200, and the pet is named Rex".
- A **flow** is several requests in order, passing what one returns to the next, to show that something a user does
  works: "can book an order" (find an item, create the order, pay, fetch the receipt). A flow can span services.
- A flow has **inputs**, like a GitHub workflow's inputs or Storybook's controls: a quantity, or a pet chosen from the
  ones the flow just found. In the portal they are controls you change before you press Run; on the command line they
  are `--input quantity=2`. Inputs carry defaults, so a flow runs unattended in CI and as a monitor; `--input`
  overrides one.

The same file is then:

- **browsed and run by QA** in a published portal, with a click;
- **run by CI** on every change, against different environments;
- **run as a monitor** against production, on a schedule.

Keep the specs in the repository (or fetch them at a pinned address, see below), and a checkout is all CI needs. A
monitor needs even less: one compiled file and node.

| Who | Does what | With |
| --- | --- | --- |
| Developer | writes requests and flows, tries them, runs the tests | `specbook dev`, `specbook test` |
| CI | runs the tests on a change, then builds the portal for QA and the test file for ops | `specbook test --env staging`, `specbook build --minimal`, `specbook bundle` |
| QA | opens the portal CI published and runs a request or a flow | a browser |
| Ops | runs the file CI built against production, on a schedule | `node specbook-tests.mjs --env prod --safe` |

## Developer

Write requests (`requests/**/*.req.ts`) and flows (`sequences/**/*.seq.ts`), and try them in `specbook dev`.

```ts
// requests/petstore/get-pet.req.ts
import { GetPetById } from '#api/petstore'

export default GetPetById.request({
  name: 'Get a pet',
  tags: ['smoke', 'monitor'],
  path: { petId: 1 },
})
```

That is a complete smoke test. A request with no `assert` passes only on a 2xx response (the check is listed as
`status is 2xx`).

### Assertions

Say what "worked" means with `assert`. It receives the response and an `assert` helper:

```ts
// requests/petstore/find-pets.req.ts
import { FindPetsByStatus } from '#api/petstore'

export default FindPetsByStatus.request({
  name: 'Find pets by status',
  tags: ['smoke'],
  query: { status: 'available' },
  assert: (res, { assert }) => {
    assert.is(res.status, 200, 'ok')
    if (res.status === 200) assert.ok(res.data.length > 0, 'returns at least one pet')
  },
})
```

- An `assert` replaces the 2xx check, so the request is judged by it alone. A request that expects a 404 asserts
  that: `assert.is(res.status, 404, 'no such pet')`.
- The helpers are [uvu/assert](https://github.com/lukeed/uvu/blob/master/docs/api.assert.md): `ok`, `is`, `equal`,
  `match`, `type`, `instance` and `throws`, with `not.` versions. Specbook records each call and takes an extra last
  argument, the label shown in the report.
- Narrow on the status first (`if (res.status === 200)`): `res.data` then has the type the spec gives that response.
- Every check runs and each is reported, passing or failing, with what was expected and what came back. A failed check
  does not hide the ones after it.


### A flow

A flow strings requests together. Each request can `capture` values from its response, and later steps use them.
Flows are **strongly typed**: a captured value has the type the spec gives that response (below, `ctx.captured.pets` is
a list of pets, so `p.name` is checked and a misspelt field is a compile error), inputs have the type of their control,
and each request's path, query and body are typed from the spec.

```ts
// sequences/adopt-pet.seq.ts
import { c, sequence } from '@specbook/core'
import findPets from '../requests/petstore/find-pets.req'
import getOrder from '../requests/petstore/get-order.req'
import placeOrder from '../requests/petstore/place-order.req'

export default sequence({
  id: 'adopt-pet',
  title: 'Adopt a pet',
  description: 'Find available pets, pick one, order it, then verify the order.',
  tags: ['petstore', 'smoke'],
  inputs: {
    quantity: c.number({ default: 1, min: 1, description: 'How many of the chosen pet to order.' }),
  },
})
  .step('Find available pets', findPets) // captures `pets` from the response
  // QA picks a pet in the portal; automation is not asked and takes the default, the first one
  .input('Choose a pet', (ctx) => ({
    petId: c.select(ctx.captured.pets, {
      label: (p) => `${p.name} (#${p.id})`,
      value: (p) => p.id as number,
      default: 0,
    }),
  }))
  .step('Place order', placeOrder) // sends { petId, quantity }
  .step(
    'Verify order',
    getOrder.with({
      assert: (res, { assert, vars }) => {
        assert.is(res.status, 200, 'order found')
        if (res.status === 200) assert.is(res.data.petId, vars.petId, 'order matches the chosen pet')
      },
    }),
  )
```

Each step is a request you can also run on its own. A flow can mix services: its steps go to their own service's
address, with that service's credentials.

### Inputs

A flow's inputs are the values a person would want to change: **`inputs`** on the flow are asked for up front
(`quantity`), and an **`.input()`** step asks in the middle, using what the flow has found so far (a list of pets to
choose from). They are built with `c.number`, `c.text`, `c.select` and the other controls, which also give the portal
its form fields.

- In the portal each input is a control, with its description and limits. The person changes it and presses Run: QA
  picks the pet, or the quantity. **Run with defaults** skips the questions and uses every default, as automation does.
- In automation nobody is asked. `specbook test` and a bundle give every input its default, so the example orders
  the first pet it finds (`default: 0`) and a quantity of 1. `--input quantity=3 --input petId=1002` overrides them
  when you want a particular case. A flow therefore needs defaults that make sense unattended; a `c.select` whose
  default is the first item is the usual one.

### Generated values

An input can start from generated data instead of a fixed value, so QA gets a realistic customer without typing one
and every automated run sends something different:

```ts
// sequences/stripe-checkout.seq.ts
import { c, sequence } from '@specbook/core'
import { faker } from '@specbook/core/faker'

export default sequence({
  id: 'stripe-checkout',
  title: 'Stripe checkout and refund',
  inputs: {
    fullName: c.text({
      default: () => faker.person.fullName(),
      description: 'The customer to create.',
    }),
    amount: c.number({ default: 2000, min: 50 }),
  },
})
  .step('Create customer', createCustomer) // sends { name: '{{fullName}}' }
  .step('Create payment intent', createIntent)
```

- In the portal the control opens with a generated name. QA edits it, or presses its **Generate** button for another
  one (**Generate all** when there are several), then Run.
- In automation the default is generated fresh for each run. `--locale de` makes the names German (the locales are
  listed in the config's `faker`), and `--seed 42` makes a run repeatable, which is how you reproduce a failure that
  depended on the data. `--input fullName="Ada Lovelace"` pins one.

### Running them

```sh
npx specbook test                      # every request and flow, against mock data
npx specbook test --env staging        # against a real environment
npx specbook test --tag smoke          # by tag; requests carry tags too
npx specbook test --grep pet --list    # what would run, without running it
```

`mock` is for development: it answers from the examples that `specbook generate` writes, which your machine has.
Every other environment calls the real API.

### The specs

Your OpenAPI specs are the source of everything specbook generates (types, operations and mock examples), and it
generates only when they are missing or out of date. Commit your specs and a fresh checkout is all CI needs.

To start from a published document, let specbook fetch it:

```sh
npx specbook add stripe --spec https://raw.githubusercontent.com/stripe/openapi/<commit>/openapi/spec3.json
npx specbook add --refresh             # fetch the recorded addresses again and say what changed
```

The document is saved as `openapi/stripe.json` and recorded in `openapi/sources.json` (address, sha256, size), which
you commit. Use an address pinned to a commit so a refresh is a choice. A `.json.gz` or `.yaml.gz` spec is read as it
is, if a project prefers to keep it compressed.

## QA: the portal

```sh
npx specbook build --minimal           # a site with just your requests and flows
npx specbook build                     # the full API reference, for developers
```

`--minimal` publishes the operations your requests and flows use, with those requests and flows, and leaves the rest
of the API out, so the site is small and does not list every endpoint. Put the folder on any static host.

QA opens the portal, picks a request or a flow, chooses an environment and presses Run. A failed check opens on its
own, with what was expected and what came back. **New environment…** copies an environment, for pointing a copy at a
branch deployment. Credentials are typed once per tab and kept per API origin; they are never part of the site.

Before you publish:

- The addresses in your config and the values in `.specbook/environments/<env>.env` are visible to anyone who can
  open the portal. Secrets are not, because they are never built in.
- A browser can call a live API only if the API allows it (CORS), or through the browser extension.
- A flow that spans services works: each step goes to its own service's address and uses its own credentials.

## CI

```yaml
# .github/workflows/test.yml
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npm ci
      - run: npx specbook check
      - run: npx specbook test --env staging --reporter list --reporter junit:reports/junit.xml
        env:
          PETSTORE_API_KEY: ${{ secrets.PETSTORE_API_KEY }}
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: reports, path: reports }
```

Secrets are read from environment variables named in the config (`secrets: { PETSTORE_API_KEY: {} }`), so a CI secret
store is all it needs. Under GitHub Actions the failures are also annotated on the change, with a summary on the run.

### Reading a failure

```
 FAIL  requests/petstore/get-pet.req.ts › Get a pet  [staging] 84ms
    ✗ status is 2xx
      - Expected  + Received
      - status 2xx
      + status 404 Not Found
    Request   GET https://staging.petstore.example/api/v3/pet/1
      x-api-key: ***
    Response  404 Not Found  84ms
      content-type: application/json
      x-request-id: 5f1c…
      { "message": "Pet not found" }
    Re-run: specbook test requests/petstore/get-pet.req.ts --env staging --grep "Get a pet"
```

The portal shows the same expected-and-received diff. The request and response are shown with credentials removed
(`authorization`, `cookie`, `set-cookie`, `x-api-key`, and fields such as `access_token` and `password`), and every
secret value your run used is masked wherever it appears, including URL-encoded and base64 forms. `--trace always`
shows the exchange for passing steps too; `--trace off` leaves it out.

| Exit code | Meaning |
| --- | --- |
| 0 | every flow passed (one that passed on a retry is reported as flaky) |
| 1 | a flow failed or errored (a check, an HTTP or network error, a timeout) |
| 2 | it could not run: missing secrets, a spec that is missing, an import that is no operation |
| 3 | usage: an unknown environment or flag |

The report says which of failed and errored it was, so an API that is down reads differently from one that answered
wrongly.

Reporters: `list` (the default), `json`, `junit`, `github` and `ndjson`, each optionally written to a file
(`--reporter junit:reports/junit.xml`). `--shard 1/3` runs a third of the flows, for splitting a long run.

## Ops and monitoring: one file

```sh
npx specbook bundle                              # writes specbook-tests.mjs
npx specbook bundle --out dist/monitor.mjs --tag monitor   # only what is tagged monitor
```

The bundle is **one `.mjs` file**: your requests and flows, the config, the operations they use, the examples they
name and the runner with all its reporters, compiled together. Running it needs node and nothing else, no
`npm install`, no spec, no `specbook`:

```sh
node specbook-tests.mjs --env prod --safe --tag monitor
```

It takes the flags of `specbook test` (without `mock`, which is for development) and exits with the same codes.
Secrets come from environment variables; no secrets file and no environment's secret values are ever inside it. It
also leaves out documentation, branding and the UI. A `specbook-tests.mjs.sha256` file is written beside it, so
`sha256sum -c specbook-tests.mjs.sha256` proves the file is the one the pipeline built.

Build it once in your repository's pipeline and keep it as the artifact. Whatever your requests import is compiled in.
A package that cannot be (a native addon, a computed `require`) is reported when you build, and can stay an import
with `--external <package>`; it must then be installed where the file runs. Files that requests upload are embedded
too; the build warns when they are large. If you use faker, the file carries just the locales your config names.

For a failure, a bundle shows the request and response and the expected-and-received diff as `specbook test` does,
but not a file and line: those would point into the compiled file.

### Production monitoring

```yaml
# .github/workflows/monitor.yml
on:
  schedule: [{ cron: '*/15 * * * *' }]
jobs:
  monitor:
    runs-on: ubuntu-latest
    steps:
      # download the file your pipeline built, then:
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: node specbook-tests.mjs --env prod --safe --tag monitor --retries 1 --timeout 10000 --reporter json:report.json --notify ${{ secrets.ALERT_WEBHOOK }}
        env:
          PETSTORE_API_KEY: ${{ secrets.PETSTORE_API_KEY }}
```

Runs send everything by default, so a developer can test flows that create and delete against a lower environment.
Against production pass **`--safe`**: a request that is not a GET, HEAD or OPTIONS (or a GraphQL query) is refused
before it is sent, so a monitor cannot change production data. Mark a POST that only reads with `safe: true` on the
request. Logging in through an auth profile is always allowed.

- `--retries 1` runs a failed flow once more; one that then passes is flaky, exits 0 and is still reported.
- `--timeout` is per request (30 s by default); `--global-timeout` stops the whole run.
- `--bail 1` stops at the first failed flow.
- `--notify` posts a summary to a webhook when something fails.
- The JSON report records the environment, versions, git commit, CI run, timings and each service's address (its
  origin only).

## Troubleshooting

- **Missing secrets (exit 2).** The names are listed; set them as environment variables or in
  `.specbook/environments/<env>.secrets.env`. `specbook secrets --env <name>` shows where each one resolves from.
- **"Not operations of the spec".** A request imports a name the spec does not have: a typo, or an operation the
  spec dropped. `specbook check` lists where.
- **A spec is missing in CI.** Commit it, or fetch it with `specbook add` / a pinned download before `specbook test`.
- **The bundle will not compile.** The message names the import. Put the package behind `--external`, or replace it.
- **A portal call fails with a network error.** The API probably does not allow calls from the portal's address
  (CORS). Serve the portal from the API's own origin, or use the browser extension.
- **A flow passes on retry.** It is flaky: look at the trace of its first attempt with `--trace always`.
