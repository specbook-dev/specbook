/** The five pages, in the order a visitor meets them: what each is for, in a line. */
export const PAGES = [
  {
    slug: 'discover',
    name: 'Discover',
    line: 'Open any OpenAPI file and use it, with nothing to install.',
  },
  {
    slug: 'develop',
    name: 'Develop',
    line: 'Your spec becomes types and runnable requests, tried as you write them.',
  },
  {
    slug: 'document',
    name: 'Document',
    line: 'The same requests are your API docs, on your own site, runnable in place.',
  },
  {
    slug: 'test',
    name: 'Test',
    line: 'The same request or flow, run by QA with a click and by CI on every change.',
  },
  {
    slug: 'monitor',
    name: 'Monitor',
    line: 'One file that runs anywhere with just node, against production, on a schedule.',
  },
] as const

export type PageSlug = (typeof PAGES)[number]['slug']
