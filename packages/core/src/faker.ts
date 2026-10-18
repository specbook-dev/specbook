// The `faker` request and flow files import (`@specbook/core/faker`), typed as faker's own `Faker` so a typo or a
// wrong argument fails `tsc` and the editor completes. `@faker-js/faker` is the project's dependency (`specbook init` adds it);
// the runtime in ./faker-runtime installs the real instance before each run.

import type { Faker } from '@faker-js/faker'
import { faker as runtime } from './faker-runtime'

export const faker = runtime as unknown as Faker
