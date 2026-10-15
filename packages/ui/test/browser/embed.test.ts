import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../src/embed'

const play = () => document.querySelector('specbook-play') as HTMLElement
const panel = () => document.querySelector('specbook-panel') as HTMLElement | null
const q = (sel: string) => panel()?.shadowRoot?.querySelector(sel) ?? null

describe('embed', () => {
  afterEach(() => {
    panel()?.remove()
    document.body.innerHTML = ''
    for (const s of document.head.querySelectorAll('style')) s.remove()
  })

  const host = async (css = '') => {
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
    document.body.innerHTML =
      '<p data-specbook="petstore" data-operation="GetPetById">Get a pet</p>'
    await vi.waitFor(() => expect(play()).not.toBeNull())
  }
  const open = async () => {
    play().shadowRoot?.querySelector('button')?.click()
    await vi.waitFor(() => expect(q('.request-panel .rq-bar')).not.toBeNull(), {
      timeout: 30_000,
    })
  }

  it('adds a Play button to data-specbook elements, also ones added later', async () => {
    await host()
    expect(play().shadowRoot?.querySelector('button')?.textContent).toBe('▶ Play')
    document.body.insertAdjacentHTML(
      'beforeend',
      '<p data-specbook="petstore" data-operation="AddPet">x</p>',
    )
    await vi.waitFor(() => expect(document.querySelectorAll('specbook-play').length).toBe(2))
  })

  it('opens the panel in a shadow root that host CSS cannot reach', async () => {
    await host('* { color: red !important; font-family: serif } button { background: red }')
    await open()
    expect(document.querySelector('.panel')).toBeNull()
    expect(getComputedStyle(q('.sb-root') as Element).color).not.toBe('rgb(255, 0, 0)')
    expect(getComputedStyle(q('.panel-head h2') as Element).color).not.toBe('rgb(255, 0, 0)')
    expect(getComputedStyle(q('.btn') as Element).backgroundColor).not.toBe('rgb(255, 0, 0)')
  })

  it('is themed with plain host CSS tokens and ::part', async () => {
    await host(
      'specbook-panel { --sb-surface: rgb(1, 2, 3) } specbook-panel::part(header) { border-bottom: 3px solid rgb(9, 9, 9) }',
    )
    await open()
    expect(getComputedStyle(q('.panel') as Element).backgroundColor).toBe('rgb(1, 2, 3)')
    expect(getComputedStyle(q('.panel-head') as Element).borderBottomWidth).toBe('3px')
  })

  it('closes with Escape', async () => {
    await host()
    await open()
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await vi.waitFor(() => expect(q('.panel')).toBeNull())
  })

  it('is a modal dialog, and can open on the Docs tab', async () => {
    document.body.innerHTML =
      '<p data-specbook="petstore" data-operation="AddPet" data-tab="docs">Add a pet</p>'
    await vi.waitFor(() => expect(play()).not.toBeNull())
    play().shadowRoot?.querySelector('button')?.click()
    await vi.waitFor(() => expect(q('.panel table.fields')).not.toBeNull(), { timeout: 30_000 })
    expect(q('.panel')?.getAttribute('aria-modal')).toBe('true')
    expect(q('.panel')?.getAttribute('role')).toBe('dialog')
    expect(q('.panel-backdrop')).not.toBeNull()
    expect(q('.prism-code-editor')).toBeNull()
  })
})
