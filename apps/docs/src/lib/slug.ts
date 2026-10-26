// The address of a section: its title in lowercase, words joined by hyphens, punctuation gone. The same shape Starlight
// gives the headings of the reference pages, so every page of the site links to a section the same way.

export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
