---
title: Adding a pet
---

Adding a pet registers it in the store. Send the pet's **name** and at least one **photo URL**; the
store assigns an `id` when you leave it out.

Press **Play** to try it against the mock. The request gives every pet a generated name (`petName`), so
each play sends a new one.

## What to send

The name is shown in the shop's catalogue, so keep it under 40 characters. Names are not unique. Give at
least one photo URL: the demo store does not fetch them, so any `https://` address works.

<!-- specbook: body -->
