# Guided workspace update: acceptance checklist

User-requested scope, 2026-10-10. Target: main, then the isolated test environment. Production, npm versions and published tags do not change.

1. GitHub setup separates account/organization and repository name. A visible creation entry opens GitHub's official new-repository page; the user confirms creation and visibility there. Do not create a real repository during tests.
2. Present one setup page at a time. Cloud tasks: authorize account → select repository → tasks/review. Computer file sync: select repository → authorize a connected computer → upload/download. These are distinct authorizations; cloud OAuth never grants local filesystem consent.
3. After setup show common actions; repository, account/device settings and advanced actions stay behind separate entries. Preserve permission checks, exact-device routing, automatic/manual upload, recovery, personal branches and reviewed draft PR publication.
4. Desktop, phone and tablet share one Agent-settings button/dialog containing Agent, model, reasoning and cloud-workspace options. Preserve the two explicit Chat/Agent sends, local pause/resume and mobile invocation of the same account's computer runtime. Send buttons remain reachable in short windows and under the test banner.
5. Cloud pending states never wait for a local connector or call its pause/resume API. Diagnose the accepted request's real failure, retaining bounded safe terminal codes and provider-attempt counts without exposing exception text or secrets. Do not weaken resource, quota or permission boundaries.

   The project lead subsequently authorized a five-minute trial task deadline after the completion bug is fixed. Keep the existing 30-second per-provider deadline and resource/call/token limits. Existing GitHub repository tasks retain their fifteen-minute deadline.
6. Refresh and example navigation never flash login before the HttpOnly session restore settles. Do not cache credentials or guess authentication. Anonymous users must still reach login; module-load failure offers reload.
7. Keep concise Chinese/English guidance and the isolated example functional. Validate with normal pointer clicks on Chromium/WebKit and an independent native Safari preview; mocks replace providers and GitHub writes. Keep live-provider verification and deployment evidence separately qualified.
