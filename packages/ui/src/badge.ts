const OWN = /(^|\.)specbook\.dev$/i

/**
 * "Powered by Specbook" shows on a published site (a build, or the viewer on someone's own host) and
 * not for the author running the dev server, nor on specbook.dev itself, where the name is already
 * everywhere. A project turns it off with `branding.badge: false`.
 */
export function showBadge(o: { host: string; published: boolean; badge?: boolean }): boolean {
  return o.published && o.badge !== false && !OWN.test(o.host)
}

/** The link back carries the host, so a site's referrals can be told apart without any tracking script. */
export const badgeHref = (host: string) =>
  `https://docs.specbook.dev/?ref=${encodeURIComponent(host)}`
