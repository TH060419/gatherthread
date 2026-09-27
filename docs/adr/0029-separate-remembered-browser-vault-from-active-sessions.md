# ADR-0029: Separate remembered-browser choices from active sessions

**Date**: 2026-09-24
**Status**: proposed; pending project-lead review
**Deciders**: pending project-lead review

## Context

An Alpha tester may use more than one GatherThread account in one browser profile. Logging out must revoke the active session, while an explicit **Remember this device** choice should still offer a quick account selection later. Reusing the active session Cookie as the account list would couple logout to forgetting every choice and would make multi-account switching ambiguous. Persisting device access tokens in Web Storage would expose long-lived credentials to page JavaScript.

## Decision

Keep the active browser session and remembered-account vault as separate credentials. The vault is an opaque, 30-day `HttpOnly; SameSite=Strict; Path=/` Cookie, with `Secure` and `__Host-` under HTTPS. SQLite stores only its peppered token digest and account/device bindings with device-token version, expiry and the last-used display/device labels. No device access token is stored in the browser vault or returned by its listing endpoint.

Only an explicit remember choice adds an account. Listing returns only choices in that browser profile. Activating a choice requires an allowed Origin, editable display and device labels, a valid unrevoked device and a fresh browser session; it rotates the vault credential. Logging out revokes only the active session. An explicit Forget removes one choice, and device revocation or credential rotation invalidates its binding. Cookie-authenticated writes and activation remain rate-limited and Origin-checked.

Older remembered browser sessions stay usable without changing the vault on `GET /v1/me`. The Web client attempts an optional, idempotent `POST /v1/remembered-accounts/adopt-current-session` under the allowed-Origin gate. Failed adoption does not log out the active session.

For one-use test-qualification and invitation claims, the claim transaction issues the unique device credential and browser session before an optional vault registration. A vault write failure cannot suppress delivery of an already committed device credential: the response still returns the credential once and omits the vault Cookie. A later successful login may add the choice. Browser/session claim errors before commit remain failures and do not consume the one-use secret.

## Alternatives considered

- **Keep device access tokens in localStorage:** simpler switching, but a page script could read a long-lived device credential. Rejected.
- **Use the active session as the account list:** logout would also erase quick-login choices or leave a supposedly logged-out session usable. Rejected.
- **Require the user to re-enter each device token after every logout:** safest for shared browsers, but defeats the explicit quick-login choice on a personal browser. Remains available by not selecting Remember or by using Forget.

## Consequences and validation

Anyone with access to an unlocked, remembered browser profile can activate a listed account. The login UI and documentation must warn against using this feature on a shared device; logout alone is not Forget. Server tests cover multi-account listing, Origin rejection, token-version revocation, logout retention, explicit Forget, and optional vault-write failure after a one-use claim. Protocol schemas reject unknown activation fields. This decision does not introduce passwords or public registration.
