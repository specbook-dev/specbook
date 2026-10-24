import { c, sequence } from '@specbook/core'
import { faker } from '@specbook/core/faker'

// A flow with no request: it exists to show what QA gets from the inputs. Change how many travelers, press the die to make
// another name for one traveler, or Generate all for a new set, then Run to see the checks.
export default sequence({
  id: 'ui-demo',
  title: 'Dynamic inputs',
  group: 'UI',
  description:
    'A demo of generated inputs, with no request to send. A booking starts with two travelers (1 to 10): set how many, make a first and last name for each with the dice or Generate all, choose a gender, say which one is the primary traveler, and give a date of birth if you want to. Run only checks what was entered.',
  tags: ['demo'],
  inputs: {
    travelers: c.array(
      c.object({
        firstName: c.text({ default: () => faker.person.firstName() }),
        lastName: c.text({ default: () => faker.person.lastName() }),
        gender: c.select(['female', 'male', 'other'] as const),
        role: c.select(['primary', 'companion'] as const, { default: 'companion' }),
        dateOfBirth: c.date({ description: 'Optional.' }),
      }),
      {
        min: 1,
        max: 10,
        label: 'Travelers',
        // the first is the primary traveler; each one is made from the defaults above, with its own generated names
        default: () => [{ role: 'primary' }, {}],
      },
    ),
  },
})
  .check('Every traveler has a first and last name', (ctx, { assert }) => {
    for (const t of ctx.inputs.travelers)
      assert.ok(t.firstName.trim() !== '' && t.lastName.trim() !== '', 'a traveler has a name')
  })
  .check('Exactly one traveler is primary', (ctx, { assert }) => {
    const primary = ctx.inputs.travelers.filter((t) => t.role === 'primary').length
    assert.is(primary, 1, `${primary} travelers are primary`)
  })
  .check('A date of birth, when given, is a date', (ctx, { assert }) => {
    for (const t of ctx.inputs.travelers)
      assert.ok(
        !t.dateOfBirth || !Number.isNaN(Date.parse(t.dateOfBirth)),
        'a date of birth is a date',
      )
  })
