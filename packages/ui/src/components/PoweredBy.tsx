import { badgeHref, showBadge } from '../badge'
import { brand } from '../branding'
import { isStatic } from '../runtime'

export function PoweredBy() {
  const host = globalThis.location?.hostname ?? ''
  if (!showBadge({ host, published: isStatic, badge: brand.value.badge })) return null
  return (
    <p class="powered-by">
      <a href={badgeHref(host)} target="_blank" rel="noopener">
        Powered by Specbook
      </a>
    </p>
  )
}
