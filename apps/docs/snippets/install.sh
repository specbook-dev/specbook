# #region install
npm install --save-dev @specbook/cli @specbook/core
specbook init     # config, a tsconfig and an agent guide; adds typescript and faker to package.json
npm install       # fetches what init added
specbook add petstore --spec https://petstore3.swagger.io/api/v3/openapi.json
# #endregion install

# #region install-plaid
npm install --save-dev @specbook/cli @specbook/core
specbook init     # config, a tsconfig and an agent guide; adds typescript and faker to package.json
npm install       # fetches what init added
specbook add plaid --spec https://raw.githubusercontent.com/plaid/plaid-openapi/master/2020-09-14.yml --base-url https://sandbox.plaid.com
# #endregion install-plaid

# #region agents
npx specbook init             # writes .specbook/agent-guide.md, and an AGENTS.md if you have none
npx specbook init --agents    # adds the Specbook section to an AGENTS.md or CLAUDE.md you already have
# #endregion agents

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
