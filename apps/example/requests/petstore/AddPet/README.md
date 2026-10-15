---
title: Adding a pet
---

Adding a pet registers it in the store. Send the pet's **name** and at least one **photo URL**; the
store assigns an `id` when you leave it out.

Press **Play** to try it against the mock, and switch the example to *Dynamic* for a fresh name on
every request.

## `name`

Shown in the shop's catalogue, so keep it under 40 characters. Names are not unique.

## `photoUrls`

At least one URL. The demo store does not fetch them, so any `https://` address works.
