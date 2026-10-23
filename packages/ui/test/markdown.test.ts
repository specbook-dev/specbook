import { describe, expect, it } from 'vitest'
import {
  firstParagraph,
  inlineMarkdown,
  inlineSummary,
  markdownToHtml,
  plainText,
} from '../src/markdown'

describe('a description written in HTML', () => {
  it('is read as the markdown it means, with no tag shown as text', () => {
    expect(
      markdownToHtml(
        '<p>Creates a <code>Link</code>.</p><p>See <a href="https://example.com">docs</a>.</p>',
      ),
    ).toBe(
      '<p>Creates a <code>Link</code>.</p><p>See <a href="https://example.com" target="_blank" rel="noreferrer">docs</a>.</p>',
    )
    expect(plainText('<p>One <strong>two</strong></p>')).toBe('One two')
    expect(inlineSummary('<p>First.</p><p>Second.</p>')).toBe('First.')
  })

  it('leaves text that only looks like a tag, and fenced code, alone', () => {
    expect(markdownToHtml('Send <name> as the id.')).toBe('<p>Send &lt;name&gt; as the id.</p>')
    expect(markdownToHtml('```\n<p>x</p>\n```')).toBe(
      '<pre><code>&lt;p&gt;x&lt;/p&gt;</code></pre>',
    )
  })
})

describe('markdownToHtml', () => {
  it('renders paragraphs, emphasis, code and links', () => {
    const html = markdownToHtml(
      'Find a **pet**, then `order` it.\nSee [the docs](https://example.com/x) and *this*.\n\nSecond paragraph.',
    )
    expect(html).toBe(
      '<p>Find a <strong>pet</strong>, then <code>order</code> it. See ' +
        '<a href="https://example.com/x" target="_blank" rel="noreferrer">the docs</a> and <em>this</em>.</p>' +
        '<p>Second paragraph.</p>',
    )
  })

  it('renders lists, headings and fenced code', () => {
    const html = markdownToHtml(
      '# Title\n- one\n- two\n\n1. first\n2. second\n\n```\nGET /pets <ok>\n```',
    )
    expect(html).toBe(
      '<h2>Title</h2><ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>' +
        '<pre><code>GET /pets &lt;ok&gt;</code></pre>',
    )
  })

  it('escapes HTML and only links http(s) and mailto', () => {
    const html = markdownToHtml(
      '<script>alert(1)</script> [x](javascript:alert(1)) [y](https://ok.test)',
    )
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('href="javascript')
    expect(html).toContain('href="https://ok.test"')
  })

  it('renders blockquotes', () => {
    expect(markdownToHtml('> Tip: **go**\n> on')).toBe(
      '<blockquote>Tip: <strong>go</strong> on</blockquote>',
    )
  })

  it('leaves code spans alone', () => {
    expect(markdownToHtml('use `**not bold**` here')).toBe(
      '<p>use <code>**not bold**</code> here</p>',
    )
  })

  it('returns an empty string for nothing', () => {
    expect(markdownToHtml(undefined)).toBe('')
    expect(markdownToHtml('')).toBe('')
  })
})

describe('single-line helpers', () => {
  const spec =
    'Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in `lowercase`.\n\nMust be a supported currency.'

  it('takes the first paragraph and flattens its lines', () => {
    expect(firstParagraph('a\nb\n\nc')).toBe('a b')
    expect(firstParagraph(undefined)).toBe('')
  })

  it('renders inline markup in a cell and nothing else', () => {
    expect(inlineSummary(spec)).toBe(
      'Three-letter <a href="https://www.iso.org/iso-4217-currency-codes.html" target="_blank" rel="noreferrer">' +
        'ISO currency code</a>, in <code>lowercase</code>.',
    )
    // a list is not turned into block markup inside a cell
    expect(inlineMarkdown('- not a list')).toBe('- not a list')
  })

  it('does not cut markdown in the middle, and falls back to plain text when long', () => {
    const long = `See [the guide](https://example.com/g) ${'word '.repeat(80)}`
    const html = inlineSummary(long, 60)
    expect(html).not.toContain('<a')
    expect(html.endsWith('…')).toBe(true)
    expect(html.length).toBeLessThan(80)
  })

  it('reduces markdown to plain text for tooltips', () => {
    expect(plainText(spec)).toBe(
      'Three-letter ISO currency code, in lowercase. Must be a supported currency.',
    )
    expect(plainText('## Title\n- one\n- two\n```\ncode\n```')).toBe('Title one two')
  })

  it('leaves ordinary punctuation alone', () => {
    expect(inlineSummary('price * quantity, snake_case_name, 5 > 3')).toBe(
      'price * quantity, snake_case_name, 5 &gt; 3',
    )
  })
})
