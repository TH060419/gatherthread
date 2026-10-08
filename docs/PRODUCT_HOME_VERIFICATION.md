# Product home browser checks

The product home is the independent `site/` presentation. Do not use real accounts, model calls, or repository writes to check it. Build and start the same-origin preview:

```sh
npm run build:web
GATHERTHREAD_WEB_PORT=18842 node apps/web/scripts/serve.mjs
```

With the Playwright CLI installed, open a temporary Chrome session and run the browser regression function:

```sh
playwright-cli -s=gt-home-check open 'http://127.0.0.1:18842/?theme=light' --browser chrome
playwright-cli -s=gt-home-check run-code --filename apps/web/scripts/check-product-home-browser.cjs
playwright-cli -s=gt-home-check close
```

Repeat in a separate `--browser webkit` session. The function checks ordinary pointer clicks after wheel scrolling, workflow tabs and keyboard navigation, FAQ expansion, compact menus, seven viewport sizes in both languages, cross-tab language updates, dark appearance, reduced motion, no-JavaScript content, and same-origin app/example/privacy entry. Authentication reads are stubbed before opening `/app/`; no account or Agent is invoked. It throws on failed checks rather than retrying or forcing clicks.

Native Safari and actual touch-device checks complement the automated engines; WebKit is not native Safari certification. In Safari, scroll forward and backward between chapters, then click a top navigation link once. Confirm it reaches the selected chapter, not just that the link receives keyboard activation. Also inspect rounded screenshots, text contrast, focus rings and glass fallbacks. No scroll handler should intercept wheel input or reposition the page after scrolling stops. The optional floating chapter indicator is omitted because it mis-targeted ordinary first clicks after WebKit wheel snapping; navigation stays in the header.

`npm run verify` covers source, static-resource MIME types, operation deep-link forwarding, shared entry contracts, existing workspace tests, integration checks and repository audits. Browser behavior is additional evidence, not a substitute for these tests. Image provenance is recorded in [the product asset README](assets/product/README.md).

## Beta launch readiness

Product-facing copy prepares the maintainer's public-registration Beta with the cloud trial Agent available. It is not evidence of a deployed service. Before publishing that Beta, verify both email registration and the cloud trial experience end to end. The current source still holds the Cloud Agent entry; server configuration alone cannot enable it. The separate reviewed entry change and provider/container prerequisites are owned by [the hosted Agent operator guide](HOSTED_AGENT.md). Keep those fail-closed gates until their checks pass.
