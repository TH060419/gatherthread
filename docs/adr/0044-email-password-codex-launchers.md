# ADR 0044: Email/password Codex Launchers with exact environment binding

Status: accepted for implementation; native artifact publication remains separately authorized.
Date: 2026-10-12.

## Context

The Web connection regressed to terminal-first instructions and excluded the test origin. Both native forms discarded the parsed origin and hardcoded production; neither distribution contained a branded app icon. The product now uses verified-email accounts and independent devices. Requiring users to copy a Token into the Launcher no longer matches its primary login experience.

## Decision

Use Launcher-first instructions on supported desktops, with terminal fallback collapsed. Web prepares a project-bound ten-minute request while the dialog opens, then a direct user click opens URI v2. This avoids an asynchronous OS-navigation gesture. v2 carries only public settings, account email and a request UUID; it never carries a password or bearer authorization. The native form pre-fills the email, visibly names production/test, and asks for the password. Both clients use only the two exact HTTPS official origins. v1 links remain production-only and retain their legacy authorization input.

Reuse `device_authorizations` lifetime/revocation with an additive cascading project-binding table. Verify the supplied email against the signed-in actor's existing HMAC mailbox digest. Native claim verifies the same account password, then rechecks password version, authorizer, project membership/deletion and one-use state inside the final transaction. The request UUID cannot authenticate by itself. Existing email/IP/browser/global password budgets and one-at-a-time scrypt capacity apply. Only native JSON POST claim bypasses the test admission Cookie; request creation still requires browser admission. Each success creates an independent device and leaves other logins intact.

The server still stores no plaintext email. Web keeps a non-secret actor-bound email hint valid for one day in sessionStorage, or 30 days in localStorage only with the existing Remember this device choice. Expired hints are not used and are removed on their next read; logout/account reset removes them. Storage failures leave a memory-only hint; older signed-in browsers may enter email once. The email is visible in the OS handoff and must not be treated as anonymous metadata. Passwords and Tokens never enter Web Storage, URIs, argv, logs or native persistent preferences. Native transport refuses redirects, bounds time/body, validates returned identity, and never automatically repeats uncertain claims.

Compile both native icon formats from the approved product PNG. Enforce bundled resources and metadata, not merely source presence. macOS Finder/Dock use declared ICNS; Windows uses window/AppUserModelID, URL DefaultIcon and an owned per-user branded shortcut. Preserve Python runtime identity. Publish rebuilt native archives together with the Web/API update; source merges do not replace old release assets.

## Consequences and verification

This refines the GUI authorization decisions in ADR-0034/0036 without removing their CLI/DSH compatibility. Invalid, expired, revoked or mismatched requests fail closed and require a fresh Web handoff. No account migration or production/test sharing is introduced. Regression coverage includes shared v1/v2 URI vectors, password/grant races and budgets, browser lifecycle/real-pointer controls, native cancellation, transport safety and bundled icon validation. Actual Windows appearance, macOS signing/notarization, PR/CI, distribution and deployment remain separately evidenced gates.
