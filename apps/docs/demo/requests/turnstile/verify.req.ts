import { Siteverify } from '#api/turnstile'

// #region verify
export default Siteverify.request({
  name: 'Verify a Turnstile token',
  tags: ['captcha'],
  init: { token: 'XXXX.DUMMY.TOKEN.XXXX' },
  // the secret is Cloudflare's published test one, so it is a variable and no secret of ours
  data: { secret: '{{turnstileDummySecret}}', response: '{{token}}' },
  capture: { verified: (res) => res.status === 200 && res.data.success },
  assert: (res, { assert }) => {
    assert.is(res.status, 200, 'answered')
    if (res.status === 200) assert.is(res.data.success, true, 'the token is valid')
  },
})
// #endregion verify
