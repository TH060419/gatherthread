---
description: Review or change this conversation's upload preference
disable-model-invocation: true
---

Inspect collaboration_get_local_sync_status first. Explain that conversation upload and project file sync are independent. Ask whether the user wants to enable/disable future conversation uploads or manually upload completed captured native turns. Confirm the exact conversation and action, then use collaboration_set_local_auto_upload or collaboration_upload_local_turns. Do not change the preference as a side effect of manual upload. Do not scan transcript files. A currently active turn stays pending until it completes.
