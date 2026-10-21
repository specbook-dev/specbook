import { describe, expect, it } from 'vitest'
import { extensionInstallUrl } from '../src/extension'

const UA = {
  chrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0',
  safari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  iosChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
}

describe('where a browser gets the extension', () => {
  it('sends Chrome, Edge and other Chromium browsers on a computer to the download', () => {
    expect(extensionInstallUrl(UA.chrome)).toMatch(/^https:\/\//)
    expect(extensionInstallUrl(UA.edge)).toMatch(/^https:\/\//)
  })

  it('sends no one else to a download that cannot work for them', () => {
    for (const [name, ua] of Object.entries(UA))
      if (name !== 'chrome' && name !== 'edge')
        expect(extensionInstallUrl(ua), name).toBeUndefined()
    expect(extensionInstallUrl('')).toBeUndefined()
  })
})
