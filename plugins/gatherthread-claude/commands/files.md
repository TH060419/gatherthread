---
description: Explain project file collaboration and separate sync authorization
---

Use collaboration_get_code_sync_status for the selected project to show separately authorized GitHub/GT Cloud file-sync status and pending file counts, without transferring files. Recommend GitHub for ongoing development and limited GT Cloud for small trials. The native connector needs separate reviewed --code-sync or --github-code-sync authorization, not a model-visible credential. Do not enable transfers or edit repository configuration implicitly. Files can be reviewed in GatherThread's Files sidebar; merges and publishing require explicit human action. Ordinary local Claude file tools remain separate from GatherThread cloud permissions.
