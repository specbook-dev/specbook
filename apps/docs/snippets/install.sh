# #region install
npm install --save-dev @specbook/cli @specbook/core @faker-js/faker
specbook init
specbook add petstore --spec https://petstore3.swagger.io/api/v3/openapi.json
# #endregion install

# #region develop
npx specbook dev                      # try requests and flows in a play panel
npx specbook test                     # run them all, against mock data
npx specbook test --env staging       # run them all, against a real environment
# #endregion develop

# #region publish
npx specbook build --minimal    # a portal with just your requests and flows, for QA
npx specbook build              # your docs, plus a script that makes any button run a request
npx specbook bundle             # your tests as one file that needs only node
# #endregion publish

# #region ci
npx specbook test --env staging --reporter list --reporter junit:reports/junit.xml
# #endregion ci

# #region monitor
npx specbook bundle --tag monitor --out specbook-tests.mjs
node specbook-tests.mjs --env prod --safe --retries 1 --timeout 10000
# #endregion monitor
