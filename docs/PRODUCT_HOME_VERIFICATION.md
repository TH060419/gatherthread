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

Repeat in a separate `--browser webkit` session. The function checks ordinary first pointer clicks after wheel scrolling on initial entry, after returning from privacy, after reduced-motion use, and after switching languages. It verifies visible, stable geometry, the actual hit target and exactly one trusted down/up/click sequence; a failed first click is not retried or forced. It also checks workflow tabs and keyboard navigation, FAQ expansion, compact menus, seven viewport sizes in both languages, cross-tab language updates, dark appearance, reduced motion, no-JavaScript content, and same-origin app/example/privacy entry. Authentication reads are stubbed before opening `/app/`; no account or Agent is invoked. Browser input diagnostics must not change page styles, disable native snapping, inject a click, or be mistaken for native Safari certification.

Native Safari and actual touch-device checks complement the automated engines; WebKit is not native Safari certification. In Safari, scroll forward and backward between chapters, then click a top navigation link once. Confirm it reaches the selected chapter, not just that the link receives keyboard activation. Also inspect rounded screenshots, text contrast, focus rings and glass fallbacks. No scroll handler should intercept wheel input or reposition the page after scrolling stops. The optional floating chapter indicator is omitted because it mis-targeted ordinary first clicks after WebKit wheel snapping; navigation stays in the header.

`npm run verify` covers source, static-resource MIME types, operation deep-link forwarding, shared entry contracts, existing workspace tests, integration checks and repository audits. Browser behavior is additional evidence, not a substitute for these tests. Image provenance is recorded in [the product asset README](assets/product/README.md).

## Beta launch readiness

Beta 1 opens the Cloud Agent Web entry while keeping local Codex as the default and the server runner off by default. Product copy is not evidence of a deployed or provider-validated service. Before test activation, verify email registration and the cloud trial experience end to end using approved test accounts, the actual model API, the digest-pinned image and the test host's Docker/socket path. The provider, resource and container prerequisites are owned by [the hosted Agent operator guide](HOSTED_AGENT.md). Missing configuration must remain unavailable rather than rerouting to another model or local device. This release does not activate production, cloud shared-summary generation or cloud Pause/Resume.
