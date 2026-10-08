# Build something together with GatherThread

[简体中文](PRODUCT_GUIDE.zh-CN.md) · [Back to README](../README.md) · [Open the example](https://gatherthread.cn/app/example.html?locale=en&topic=browse)

From “shall we make a signup page?” to a button that works: follow one small project through discussion, AI work, review, and handoff. All screenshots show the full interface of the application running its disposable example, with key controls annotated. People, messages, and Agent replies are demonstration content.

## Meet the workspace

Pick a project and conversation on the left, discuss and request AI work in the middle, and find members and invitations on the right. Each person can connect Codex or DeepSeek Harness, or choose the cloud trial Agent for a small task without local setup. Cloud usage allowances are shown in the workspace.

![Full interface with annotations: conversation, members, and Agent controls](assets/product/en/annotated/01-workspace.jpg)

For your own project, sign in, create a project and Multi conversation, then invite teammates. To join someone else's project, sign in first and accept their invitation. Connect a computer Agent through the Codex launcher or the DSH plugin; phones do not need local Agent setup.

## 1. Agree on the goal

Maya suggests a club signup page. Alex confirms the time, place, and button behavior. They discuss the same project in one conversation. Sending Chat does not start an Agent.

![Full interface with annotations: Maya and Alex agree on the signup page](assets/product/en/annotated/02-discussion.jpg)

You could try: “Make one signup page with the time, place, and a signup button. Let's leave photos for later.”

## 2. Discuss a particular message

Quote a chat message or Agent answer instead of explaining which one you meant. The quote preview stays with your draft; cancel it if you change your mind. After sending, clicking the quote takes readers to the original message.

Type `@` and select a member from the list. Simply typing someone's name is not the same as choosing them.

![Full interface with annotations: quote preview and selected mention](assets/product/en/annotated/05-quote-and-mention.jpg)

The recipient can open the mentions inbox and jump to the relevant conversation and message. This is an in-app shortcut, not a cross-device read receipt or a promise of push notifications.

![Full interface with annotations: the mentions inbox](assets/product/en/annotated/06-mentions.jpg)

Quoting or mentioning someone does not run their Agent. Chat and Agent requests remain separate actions.

## 3. Turn a long discussion into a short checklist

Choose your own connected computer Agent (Codex/DSH), select completed messages, and ask it to summarize them. In this example, the summary keeps the agreed time, place, and button behavior and leaves photos out of the first version. This step is optional and uses the selected Agent's quota.

![Full interface with annotations: the signup-page summary and original view](assets/product/en/annotated/03-summary.jpg)

Original messages and older summary versions stay available. Switch a paragraph back to its sources, switch the whole view, or select an existing summary with other messages for a new summary. Members who can write in that conversation can generate summaries; viewers can read them.

Future GatherThread Agent requests default to the summarized history. In **Settings → Summaries**, choose original history when precise wording or complete details matter, and customize the summary instructions. The reading-view toggle does not change this preference or remove history already loaded into a native Agent conversation.

![Full interface with annotations: summary settings](assets/product/en/annotated/10-summary-settings.jpg)

Summaries are useful working notes, not a lossless replacement. Check important details in the originals.

## 4. Ask your Agent to work

Alex explicitly asks: “Build the signup page from the summary above.” The answer shows whose Agent did the work and which model it used. Teammates can follow public progress and results in the same conversation, without another round of copying into a group chat.

![Full interface with annotations: Alex's Agent answer and model](assets/product/en/annotated/04-agent-work.jpg)

Models and reasoning levels come from the selected Agent's supported options. For a supported DSH route, a GatherThread choice applies to that request without changing later model choices inside DSH. During a computer Agent request, the same request button offers **Pause Agent**, then **Resume Agent**; there is no extra control to hunt for.

Resume asks the original selected Agent again and can include newer shared discussion. It does not promise to restore the native Agent's hidden reasoning state exactly. You can request your own authorized Agent, not a teammate's.

## 5. Give project files a home

For ongoing development, **choose GitHub first**. The project owner configures the repository and base branch; each member signs in to GitHub on their computer and separately authorizes that connection. Files in this local sync path go straight from the computer to GitHub, to the member's personal branch. They do not use GatherThread's cloud file quota.

![Full interface with annotations: GitHub connection and local file sync](assets/product/en/annotated/09-github.jpg)

For a small trial, choose **GT Cloud**, GatherThread's file service with 128 MiB of current file versions per user. You can try file collaboration without setting up a GitHub repository first. The destinations are managed independently: switching the displayed service does not move, enable, or delete files.

![Full interface with annotations: GT Cloud file collaboration](assets/product/en/annotated/07-file-service.jpg)

File access needs separate permission. Automatic file upload waits for Agent activity to stop and files to settle; it neither downloads nor merges automatically. A newly authorized GitHub connection starts with automatic upload on; GT Cloud starts with it off. You can change either preference or upload manually.

Conversation uploads have their own switch. Turning them off does not turn file sharing off, and the reverse is also true. Local transfers and recovery need the authorized computer to be online.

GitHub still enforces its own permissions and rules. Local transfer safety limits also apply; “not counted against GT quota” does not mean any repository size or file type is supported. See [file setup and limits](CODE_SYNC.md). Review repository workflows before automatic uploads, because a push may start GitHub Actions.

## 6. Work on your own branch, then review together

Alex makes the page. Maya improves the confirmation to “You're signed up! See you Saturday.” Each uploads to a separate personal branch. In this GT Cloud example, Maya submits her change for review, and Alex, the project owner, checks it before integrating it into the shared version.

![Full interface with annotations: personal file branches and review status](assets/product/en/annotated/07-file-versions.jpg)

![Full interface with annotations: reviewing the confirmation-message change](assets/product/en/annotated/08-review-changes.jpg)

On GitHub, use the repository's own pull-request review and permissions. GatherThread project membership does not grant GitHub access. Leaving a GatherThread project does not revoke GitHub access either.

A personal branch separates uploaded versions, **not local folders**. Use separate working copies when people or multiple tools edit files at the same time. GatherThread does not lock all Agents out of a shared directory.

## 7. Check the result, not just the answer

The free example includes a clickable signup page. Press “Sign me up” and check the confirmation. Compare the result with what the team agreed; an Agent saying “done” is not a substitute for trying the button.

![Full interface with annotations: the working signup-page confirmation](assets/product/en/annotated/14-working-result.jpg)

For real work, review the files and run the checks your project needs before approving a merge.

## 8. Leave your desk without leaving the project

Sign in to the same account on a phone or tablet. Continue the discussion, check progress, or request the Agent already connected on your computer. The mobile workspace folds projects, members, and tools into compact panels; one Agent control opens model and reasoning choices.

<img src="assets/product/en/annotated/12-phone.jpg" width="390" alt="Full interface with annotations: the shared conversation on a phone">

<img src="assets/product/en/annotated/12-phone-agent.jpg" width="390" alt="Full interface with annotations: phone Agent, model, and reasoning choices">

<img src="assets/product/en/annotated/13-tablet.jpg" width="640" alt="Full interface with annotations: the tablet conversation and controls">

For a computer Agent, keep the computer and connector online. Your phone does not need to be nearby or on the same Wi-Fi when both can reach the GatherThread server. A local-only server still needs a reachable connection. You do not install a computer Agent on your phone. Alternatively, choose the [cloud trial Agent](HOSTED_AGENT_GUIDE.md) directly on your phone; no connected computer is required, and cloud usage allowances apply.

To continue on another computer, download an uploaded file version. If the original folder is lost, recovery creates a new folder rather than deleting the old one. Unuploaded local changes are not a cloud backup. Review the target version and resolve local modifications before downloading.

## Keep conversation uploads under your control

Connected Agents receive shared conversation history without every chat message starting AI work. Work typed directly in a supported, connected Codex or DSH conversation can also be shared back to GatherThread.

![Full interface with annotations: local upload controls in session status](assets/product/en/annotated/15-history-controls.jpg)

- **Automatic upload:** each bound local conversation has its own local-to-cloud switch. Turn it off to keep later local turns local until you explicitly upload them or re-enable it.
- **Manual upload:** upload eligible completed local turns, including recovery when a Codex Hook did not capture one. Manual upload does not turn automatic upload back on.
- **Codex visible history:** initial import is on by default when each shared conversation is first established locally; Settings can turn it off. A manual import creates a new verified local task. Check it and archive the old task yourself. Continuing the old task remains local, and realtime history delivery is independent of the import setting.

An import may need the Agent's native compaction for long history. Shared original records remain available; a compacted local task is not a lossless archive. See [Codex setup and history](CODEX_CONNECT.md) and [DSH setup](DSH_CONNECT.md) for supported installation and recovery paths.

## Know who can do what

- **Multi:** the owner and participants can discuss and request their own Agents; viewers read.
- **Solo:** only its creator can write while their project role allows it. Other project members can still read it, including the project owner. Solo does not mean private.
- **Files:** GT Cloud source branches are readable across the project. GitHub visibility and permissions are managed separately on GitHub.
- **Invitations:** the owner chooses participant or viewer access. Recipients sign in before accepting. Participants and viewers can leave another person's project; shared branch work must be resolved first.

The same account can stay signed in on several devices. In **Settings → This device**, review account devices and revoke one independently. Signing out ends the current browser session; it does not disconnect separately authorized computer Agents. Password recovery revokes all devices, after which you sign in and authorize Agents again.

Before deleting an account, review its impact in account settings and transfer or delete owned projects. Your Solo cloud conversations are deleted; shared Multi content stays but its account attribution is detached. Local Agent conversations and files are not deleted. The [privacy notice](https://gatherthread.cn/privacy/) explains retention and third-party copies.

## Start your own project

Use the guides in Settings whenever you want a refresher. Their example is disposable: practice, reset, or exit without changing real projects or using your model quota. Computer, phone, and tablet guides point to the controls shown on that device.

Today's workflow is people choosing their own Agents and sharing discussion, results, and reviewed file changes. Automatic multi-Agent teams, direct cooperation between different members' Agents, and cloud Agent teams remain future plans.

[Open GatherThread](https://gatherthread.cn/) · [Codex connection](CODEX_CONNECT.md) · [DSH connection](DSH_CONNECT.md) · [Project files](CODE_SYNC.md) · [Cloud trial Agent](HOSTED_AGENT_GUIDE.md) · [Self-hosting](SELF_HOSTING.md) · [All documentation](README.md)
