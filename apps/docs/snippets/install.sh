# #region install
npm install --save-dev @specbook/cli @specbook/core
npx specbook init
npx specbook add petstore --spec https://petstore3.swagger.io/api/v3/openapi.json
# #endregion install

# #region develop
npx specbook dev                      # the docs and a play panel, as you write
npx specbook test                     # every request and flow, against mock data
npx specbook test --env staging       # the same, against a real environment
# #endregion develop

# #region ci
npx specbook test --env staging --reporter list --reporter junit:reports/junit.xml
# #endregion ci

# #region monitor
npx specbook bundle --tag monitor --out specbook-tests.mjs
node specbook-tests.mjs --env prod --safe --retries 1 --timeout 10000
# #endregion monitor
