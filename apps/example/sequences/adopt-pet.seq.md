---
title: Adopting a pet
---

This flow walks the whole **adoption** journey the way a shop front end would:

1. look up pets that are `available`,
2. let you choose one,
3. place an order for it, and
4. fetch the order back to check it points at the pet you chose.

Run it against the mock to see every step pass, or switch the environment to `live` to exercise the
[Swagger Petstore](https://petstore3.swagger.io/) itself.

> Tip: change `quantity` in **Controls** and compare the order in the *Place order* step.

## Place order

Uses the pet you chose in the previous step. `quantity` comes from **Controls**; the order's `petId`
should match the pet, which the next step verifies.

## Verify order

Fetches the order back by id and checks it points at the pet you chose. If this fails against `live`,
the Petstore sandbox has probably been reset; run the flow again.
