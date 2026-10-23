// Mobile presentation owns no data or permissions. The original controls move
// into short, focused pages and return to their exact desktop positions.
const DIALOG_ACTION_IDS = new Set(["new-project-button", "new-session-button", "rename-project-button",
  "delete-project-button", "leave-project-button"]);

export function sessionNavigationLeavesPanel(button) {
  return Boolean(button && !button.disabled
    && (button.classList?.contains("session-button") || DIALOG_ACTION_IDS.has(button.id)));
}

export function toolsActionLeavesPanel(button) {
  return Boolean(button && !button.disabled && !button.closest(".session-toolbar-trigger")
    && !button.closest("#session-context-panel"));
}

export function sessionMatchesQuery(text, query) {
  return String(text ?? "").normalize("NFKC").toLocaleLowerCase()
    .includes(String(query ?? "").trim().normalize("NFKC").toLocaleLowerCase());
}

export function mountMobilePanels({ document: doc, window: win, t = value => value }) {
  const el = id => doc.getElementById(id);
  const translations = [];
  const placements = [];
  let active = false;
  const node = (tag, className = "", id) => {
    const result = doc.createElement(tag); result.className = className;
    if (id) result.id = id;
    return result;
  };
  const text = (tag, source, className = "", id) => {
    const result = node(tag, className, id); result.setAttribute("data-i18n-skip", "");
    translations.push(() => { result.textContent = t(source); }); return result;
  };
  const button = (source, id, className = "mobile-panel-row") => {
    const result = text("button", source, className, id); result.type = "button"; return result;
  };
  const remember = (control, target) => {
    if (!control || !target) return;
    const marker = doc.createComment("mobile panel control home"); control.before(marker);
    placements.push({ control, marker, target });
  };
  const page = (host, id, title, backAction) => {
    const result = node("section", "mobile-panel-page", id); result.hidden = true;
    const heading = node("div", "mobile-panel-page-heading");
    const back = button("Back", `${id}-back`, "mobile-panel-back"); back.addEventListener("click", backAction);
    heading.append(back, text("h3", title)); result.append(heading); host?.append(result); return result;
  };
  const addCaption = (control, source) => {
    if (!control) return;
    control.append(text("span", source, "mobile-panel-button-caption"));
  };

  // Conversations: project picker, one primary new-conversation action and a
  // searchable list. Project administration stays on a separate page.
  const sessionsHost = el("mobile-sessions-content");
  const sessions = node("div", "mobile-navigation", "mobile-navigation"); sessions.hidden = true;
  const sessionHome = node("section", "mobile-panel-page", "mobile-session-home");
  const projectRow = node("div", "mobile-project-row");
  const projectField = node("div", "mobile-project-field");
  const projectLabel = text("label", "Current project", "mobile-panel-eyebrow"); projectLabel.htmlFor = "project-select";
  const projectOptions = node("button", "mobile-project-options", "mobile-project-options");
  projectOptions.type = "button"; projectOptions.textContent = "•••";
  projectOptions.setAttribute("data-i18n-skip", "");
  translations.push(() => {
    projectOptions.setAttribute("aria-label", t("Project options"));
    projectOptions.title = t("Project options");
  });
  projectOptions.setAttribute("aria-controls", "mobile-project-management");
  projectRow.append(projectField, projectOptions); projectField.append(projectLabel);
  const newSessionHost = node("div", "mobile-new-conversation");
  const searchBox = node("div", "mobile-session-search");
  const searchLabel = text("label", "Search conversations", "sr-only"); searchLabel.htmlFor = "mobile-session-search";
  const search = node("input", "", "mobile-session-search"); search.type = "search"; search.autocomplete = "off";
  search.spellcheck = false;
  translations.push(() => { search.placeholder = t("Search conversations"); search.setAttribute("aria-label", t("Search conversations")); });
  searchBox.append(searchLabel, search);
  const sessionListHost = node("div", "mobile-conversation-list");
  const empty = text("p", "No matching conversations.", "mobile-panel-empty", "mobile-session-search-empty");
  empty.setAttribute("role", "status"); empty.hidden = true;
  sessionHome.append(projectRow, newSessionHost, searchBox, sessionListHost, empty); sessions.append(sessionHome);
  const projectPage = page(sessions, "mobile-project-management", "Project options", () => showSessions("home"));
  const projectActions = node("div", "mobile-project-actions"); projectPage.append(projectActions);
  sessionsHost?.append(sessions);
  remember(el("project-select"), projectField);
  remember(el("new-session-button"), newSessionHost); addCaption(el("new-session-button"), "New conversation");
  remember(el("session-list"), sessionListHost);
  remember(el("new-project-button"), projectActions); addCaption(el("new-project-button"), "Create project");
  remember(el("session-rail")?.querySelector(".project-action-row"), projectActions);
  function filterSessions() {
    if (!active) return;
    let visible = 0;
    for (const row of el("session-list")?.children ?? []) {
      row.hidden = !sessionMatchesQuery(row.textContent, search.value);
      if (!row.hidden) visible++;
    }
    empty.hidden = visible > 0 || !search.value.trim();
  }
  function showSessions(view) {
    sessionHome.hidden = view !== "home"; projectPage.hidden = view !== "project";
    if (active && view === "project") projectPage.querySelector("button")?.focus({ preventScroll: true });
    else if (active) projectOptions.focus({ preventScroll: true });
  }
  projectOptions.addEventListener("click", () => showSessions("project"));
  search.addEventListener("input", filterSessions);
  el("project-select")?.addEventListener("change", () => { search.value = ""; showSessions("home"); filterSessions(); });

  // Members: overview first; creating an invitation and joining another project
  // are distinct pages. The original owner-only visibility remains authoritative.
  // Keep mobile member pages inside their workspace tab, not beside the file
  // tabs. The original membership controls still move and retain their IDs.
  const membersHost = el("file-workspace-host") ? el("member-panel") : el("mobile-members-content");
  const members = node("div", "mobile-members-navigation", "mobile-members-navigation"); members.hidden = true;
  const membersHome = node("section", "mobile-panel-page", "mobile-members-home");
  const membersHeading = node("div", "mobile-members-heading");
  const membersList = node("div", "mobile-members-list");
  const memberActions = node("div", "mobile-member-actions");
  const invite = button("Invite people", "mobile-open-invitations");
  const join = button("Join a project", "mobile-open-join");
  invite.setAttribute("aria-controls", "mobile-invitations-page"); join.setAttribute("aria-controls", "mobile-join-page");
  memberActions.append(invite, join); membersHome.append(membersHeading, membersList, memberActions); members.append(membersHome);
  const invitePage = page(members, "mobile-invitations-page", "Invite people", () => showMembers("home"));
  const joinPage = page(members, "mobile-join-page", "Join a project", () => showMembers("home"));
  membersHost?.append(members);
  const originalMemberPanel = el("member-panel");
  const ownerInvitations = el("owner-invitations");
  remember(originalMemberPanel?.querySelector(".member-heading"), membersHeading);
  remember(el("member-list"), membersList);
  remember(ownerInvitations, invitePage);
  remember(el("accept-invitation-form")?.closest(".invitation-card"), joinPage);
  let memberView = "home";
  function showMembers(view) {
    memberView = view;
    membersHome.hidden = view !== "home"; invitePage.hidden = view !== "invite"; joinPage.hidden = view !== "join";
    if (!active) return;
    if (view === "home") (invite.hidden ? join : invite).focus({ preventScroll: true });
    else (view === "invite" ? invitePage : joinPage).querySelector("button")?.focus({ preventScroll: true });
  }
  invite.addEventListener("click", () => { if (!ownerInvitations?.hidden) showMembers("invite"); });
  join.addEventListener("click", () => showMembers("join"));

  const memberOptions = new Map();
  function restoreMemberOptions() {
    const list = el("member-list");
    for (const [row, entry] of memberOptions) {
      // A membership refresh replaces rows. Never resurrect controls belonging
      // to an earlier project, role or member list.
      if (row.parentNode !== list) continue;
      for (const { control, marker } of entry.controls) { marker.after(control); marker.remove(); }
      entry.details.remove();
    }
    memberOptions.clear();
  }
  function refreshMemberOptions() {
    if (!active) return;
    const list = el("member-list");
    for (const row of memberOptions.keys()) if (row.parentNode !== list) memberOptions.delete(row);
    for (const row of list?.children ?? []) {
      let entry = memberOptions.get(row);
      if (!entry) {
        // Only owner-rendered controls can produce an entry. This layer never
        // creates a role selector, removal action or additional permission.
        const controls = [row.querySelector(".member-role-select"), row.querySelector(".member-remove-button")].filter(Boolean);
        if (!controls.length) continue;
        const details = node("details", "mobile-member-options");
        const summary = node("summary"); summary.setAttribute("data-i18n-skip", "");
        details.append(summary);
        const homes = controls.map(control => {
          const marker = doc.createComment("mobile member control home"); control.before(marker);
          details.append(control); return { control, marker };
        });
        row.append(details); entry = { details, summary, controls: homes }; memberOptions.set(row, entry);
      }
      const caption = t("Manage member");
      if (entry.summary.textContent !== caption) entry.summary.textContent = caption;
      const name = row.querySelector(".member-copy")?.querySelector("strong")?.textContent;
      entry.summary.setAttribute("aria-label", name ? `${caption} · ${name}` : caption);
      entry.details.hidden = entry.controls.every(({ control }) => control.hidden);
    }
  }

  // One-column tools use purpose-based groups instead of a dense icon grid.
  const toolsHost = el("mobile-tools-content");
  const toolSections = [];
  const toolCaptions = [];
  for (const [title, ids] of [["Conversation", ["history-summary-menu", "session-options-menu"]],
    ["Project", ["project-code-button", "mobile-members-button", "agent-teams-button"]],
    ["More", ["settings-button", "logout-button"]]]) {
    const section = node("section", "mobile-tool-group"); section.hidden = true;
    section.append(text("h3", title, "mobile-panel-eyebrow"));
    const items = node("div", "mobile-tool-group-items"); section.append(items); toolsHost?.append(section); toolSections.push(section);
    for (const id of ids) {
      const control = el(id); remember(control, items);
      if (control?.classList.contains("icon-button")) {
        const caption = node("span", "mobile-action-caption");
        caption.setAttribute("aria-hidden", "true"); caption.setAttribute("data-i18n-skip", ""); control.append(caption);
        toolCaptions.push({ control, caption });
      } else if (control?.tagName === "DETAILS") {
        const summary = control.querySelector("summary");
        if (summary) {
          const caption = node("span", "mobile-action-caption");
          caption.setAttribute("aria-hidden", "true"); caption.setAttribute("data-i18n-skip", "");
          summary.append(caption); toolCaptions.push({ control: summary, caption });
        }
      }
    }
  }

  function refresh() {
    for (const translate of translations) translate();
    for (const { control, caption } of toolCaptions) caption.textContent = control.getAttribute("aria-label") ?? "";
    invite.hidden = !ownerInvitations || ownerInvitations.hidden;
    if (memberView === "invite" && invite.hidden) showMembers("home");
    filterSessions();
    refreshMemberOptions();
  }
  const observer = win.MutationObserver ? new win.MutationObserver(refresh) : null;
  if (el("session-list")) observer?.observe(el("session-list"), { childList: true, subtree: true, characterData: true });
  // Observe row replacement only. Wrapping controls inside a row must not
  // recursively retrigger the presentation observer.
  if (el("member-list")) observer?.observe(el("member-list"), { childList: true });
  if (ownerInvitations) observer?.observe(ownerInvitations, { attributes: true, attributeFilter: ["hidden"] });
  refresh();
  return {
    refresh,
    setActive(value) {
      if (active === value) return;
      active = value;
      if (!active) {
        restoreMemberOptions();
        for (const row of el("session-list")?.children ?? []) row.hidden = false;
        for (const { control, marker } of placements) marker.after(control);
      } else {
        for (const { control, target } of placements) target.append(control);
      }
      sessions.hidden = members.hidden = !active;
      for (const group of toolSections) group.hidden = !active;
      search.value = ""; showSessions("home"); showMembers("home"); refresh();
    },
    open(dialogId) {
      if (!active) return;
      if (dialogId === "mobile-sessions-dialog") showSessions("home");
      if (dialogId === "mobile-members-dialog") showMembers("home");
      refresh();
    },
  };
}
