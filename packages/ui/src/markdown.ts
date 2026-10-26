const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const unesc = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')

/** The address relative links in a spec's descriptions are resolved against: an http(s) URL, as a folder. */
function linkBase(docsUrl: string | undefined): URL | undefined {
  if (!docsUrl) return undefined
  try {
    const u = new URL(docsUrl)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
    if (!u.pathname.endsWith('/')) u.pathname += '/'
    return u
  } catch {
    return undefined
  }
}

/** The escaped address a link written as a path (`/api/accounts`) goes to, or nothing when there is no base for it. */
function resolveLink(target: string, base: URL | undefined): string | undefined {
  if (!base) return undefined
  try {
    const u = new URL(unesc(target), base)
    return u.protocol === 'https:' || u.protocol === 'http:' ? esc(u.href) : undefined
  } catch {
    return undefined
  }
}

/**
 * Inline markup on already-escaped text: `code`, **bold**, *italic*, and links. http(s) and mailto links are linked; a
 * link written as a path goes to `docsUrl` when the project says where its docs are, and otherwise keeps its label.
 */
function inline(text: string, docsUrl?: string): string {
  const base = linkBase(docsUrl)
  const codes: string[] = []
  let s = text.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(`<code>${c}</code>`)
    return `\uE000${codes.length - 1}\uE000`
  })
  s = s
    .replace(
      /\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/g,
      (_m, label: string, href: string) => {
        return `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`
      },
    )
    // a link written as a path on the API's own docs site (`/api/accounts`: Stripe writes them)
    .replace(
      /\[([^\]]+)\]\(((?![a-z][a-z0-9+.-]*:)[^)\s]+)\)/gi,
      (_m, label: string, target: string) => {
        const href = resolveLink(target, base)
        return href ? `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>` : label
      },
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
  return s.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => codes[Number(i)] ?? '')
}

/**
 * The HTML some specs write their descriptions in (Stripe's are `<p>…</p>`) as the markdown this file reads: the tags
 * that mean something become their markdown, and any other known tag is dropped, so none is shown as text. Text that
 * only looks like a tag (`<name>`) and fenced code are left alone.
 */
export function fromHtml(src: string): string {
  return src
    .split(/(```[\s\S]*?```)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
            .replace(/<(strong|b)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, '**$3**')
            .replace(/<(em|i)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, '*$3*')
            .replace(
              /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
              (_m, href: string, text: string) => `[${text}](${href})`,
            )
            .replace(/<li[^>]*>/gi, '\n- ')
            .replace(
              /<\/?(p|ul|ol|li|div|span|h[1-6]|table|thead|tbody|tr|td|th)(\s[^>]*)?>/gi,
              '\n',
            )
            .replace(/\n{3,}/g, '\n\n'),
    )
    .join('')
    .trim()
}

/**
 * A small, safe markdown subset for descriptions: paragraphs, headings, bullet and numbered lists, fenced
 * code, and inline code, bold, italics and links. Everything is HTML-escaped first, and only http(s) and
 * mailto links are linked, so descriptions from a spec or a sequence can be rendered without trusting them.
 */
export function markdownToHtml(src: string | undefined, docsUrl?: string): string {
  if (!src) return ''
  const lines = fromHtml(src).replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let para: string[] = []
  let list: { tag: 'ul' | 'ol'; items: string[] } | undefined

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(esc(para.join(' ')), docsUrl)}</p>`)
    para = []
  }
  const flushList = () => {
    if (list)
      out.push(
        `<${list.tag}>${list.items.map((i) => `<li>${inline(esc(i), docsUrl)}</li>`).join('')}</${list.tag}>`,
      )
    list = undefined
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (/^```/.test(line)) {
      flushPara()
      flushList()
      const code: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i] as string)) code.push(lines[i++] as string)
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flushPara()
      flushList()
      const level = Math.min(4, (heading[1] as string).length + 1)
      out.push(`<h${level}>${inline(esc(heading[2] as string), docsUrl)}</h${level}>`)
      continue
    }
    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      flushPara()
      flushList()
      const text: string[] = [quote[1] as string]
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1] as string))
        text.push((lines[++i] as string).replace(/^>\s?/, ''))
      out.push(`<blockquote>${inline(esc(text.join(' ')), docsUrl)}</blockquote>`)
      continue
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      flushPara()
      const tag = bullet ? 'ul' : 'ol'
      if (list && list.tag !== tag) flushList()
      list ??= { tag, items: [] }
      list.items.push((bullet ?? numbered)?.[1] as string)
      continue
    }
    if (line.trim() === '') {
      flushPara()
      flushList()
      continue
    }
    flushList()
    para.push(line.trim())
  }
  flushPara()
  flushList()
  return out.join('')
}

/** Markdown reduced to readable plain text: links keep their label, markers and fences disappear. */
export function plainText(src: string | undefined): string {
  if (!src) return ''
  return fromHtml(src)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/[`*]|(^|\s)_|_(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export function firstParagraph(src: string | undefined): string {
  if (!src) return ''
  return (fromHtml(src).split(/\n\s*\n/)[0] ?? '').replace(/\s*\n\s*/g, ' ').trim()
}

/** Inline markup only (code, bold, italics, links) in already-safe HTML, for a single line or cell. */
export function inlineMarkdown(src: string | undefined, docsUrl?: string): string {
  return src ? inline(esc(src), docsUrl) : ''
}

/**
 * A one-paragraph summary for table cells: inline markdown when it is short, plain text with an ellipsis
 * when it is long (cutting markdown mid-link would break it).
 */
export function inlineSummary(src: string | undefined, max = 300, docsUrl?: string): string {
  const para = firstParagraph(src)
  if (!para) return ''
  const text = plainText(para)
  return text.length > max
    ? esc(`${text.slice(0, max - 1).trimEnd()}…`)
    : inlineMarkdown(para, docsUrl)
}
