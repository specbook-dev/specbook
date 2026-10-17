/** The pages after the landing page, in the order a visitor meets them. `tile` heads the page's tile on the landing page. */
export const PAGES = [
  {
    slug: 'develop',
    name: 'Develop',
    line: 'Write requests and flows beside your spec. Run them as you write, then publish them for the whole team.',
    tile: 'Develop',
  },
  {
    slug: 'document',
    name: 'Document',
    line: 'Markdown beside every operation, or enable Try it on any button on your existing documentation site.',
    tile: 'Document',
  },
  {
    slug: 'test',
    name: 'Test',
    line: 'QA runs your published flows with a single click, and CI runs the same checks on every change.',
    tile: 'Test',
  },
  {
    slug: 'monitor',
    name: 'Monitor',
    line: 'Compile the same tests into one file that runs with just node. Run it on a schedule in production.',
    tile: 'Monitor',
  },
] as const

export type PageSlug = (typeof PAGES)[number]['slug']
