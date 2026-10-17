/** Mobile presentation of the existing code controls. No API or permission decisions live here. */
export function mobileCodeStage({ controlsHidden = true, accountHidden = true,
  repositoryHidden = true, homeHidden = true } = {}) {
  if (controlsHidden) return "unavailable";
  if (!repositoryHidden) return "repository";
  if (!accountHidden) return "account";
  if (!homeHidden) return "ready";
  return "loading";
}

export function mobileRepositoryLink(value = "") {
  if (typeof value !== "string") return null;
  const repository = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u.test(repository)) return null;
  const name = repository.split("/")[1];
  if (name === "." || name === "..") return null;
  return { repository, href: `https://github.com/${repository}` };
}

function repositoryFromLink(link) {
  try {
    const url = new URL(link?.getAttribute("href") ?? "");
    if (url.origin !== "https://github.com" || url.username || url.password) return null;
    return mobileRepositoryLink(url.pathname.split("/").slice(1, 3).join("/"));
  } catch { return null; }
}

/**
 * Restyle and disclose the original forms instead of cloning writable controls.
 * Switching presentation does not configure a repository, grant local file access,
 * or change the account/device selected by the existing controllers.
 */
export function mountMobileCodeView({ document: doc, window: win, t = text => text,
  isMobile = () => doc.documentElement.dataset.mobileWorkspace === "true" }) {
  const el = id => doc.getElementById(id);
  const dialog = el("project-code-dialog");
  if (!dialog) return { update() {}, dispose() {} };
  const root = doc.documentElement;
  const create = (tag, id, className) => {
    const node = doc.createElement(tag);
    node.id = id;
    node.className = className;
    node.setAttribute("data-i18n-skip", "");
    return node;
  };
  const intro = create("p", "mobile-code-intro", "mobile-code-copy");
  intro.hidden = true;
  el("project-code-description").after(intro);
  const note = create("p", "mobile-code-computer-note", "mobile-code-note");
  note.hidden = true;
  el("code-gt-cloud-panel").append(note);
  const localCard = create("aside", "mobile-code-computer-repository", "mobile-code-repository-card");
  localCard.hidden = true;
  const localHeading = create("span", "mobile-code-computer-label", "mobile-code-card-label");
  const localLink = create("a", "mobile-code-computer-link", "mobile-code-repository-link");
  localLink.target = "_blank";
  localLink.rel = "noopener noreferrer";
  localCard.append(localHeading, localLink);
  el("cloud-github-panel").prepend(localCard);
  let scheduled = false;
  let disposed = false;
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const hidden = (node, value) => { if (node.hidden !== value) node.hidden = value; };

  function update() {
    if (disposed) return;
    const active = typeof isMobile === "function" ? Boolean(isMobile()) : Boolean(isMobile);
    if (dialog.dataset.mobileCode !== String(active)) dialog.dataset.mobileCode = String(active);
    hidden(intro, !active);
    hidden(note, !active);
    if (!active) { hidden(localCard, true); return; }
    text(intro, t("Choose where your project files are saved."));
    text(note, t("Connect here. Upload, download and merge files on your computer."));
    const stage = mobileCodeStage({ controlsHidden: el("cloud-github-controls").hidden,
      accountHidden: el("github-cloud-account").hidden,
      repositoryHidden: el("cloud-github-repository-form").hidden,
      homeHidden: el("github-cloud-home").hidden });
    if (dialog.dataset.mobileGithubStage !== stage) dialog.dataset.mobileGithubStage = stage;
    // This metadata is populated from a committed server binding, never from
    // editable owner/repository fields or a model-produced URL.
    const cloudRepository = mobileRepositoryLink(el("github-mode-local").dataset.repository);
    const localRepository = !el("github-code-links").hidden
      ? repositoryFromLink(el("github-code-files")) : null;
    const showLocal = Boolean(localRepository && localRepository.repository !== cloudRepository?.repository);
    hidden(localCard, !showLocal);
    if (showLocal) {
      text(localHeading, t("Connected on your computer"));
      text(localLink, localRepository.repository);
      if (localLink.getAttribute("href") !== localRepository.href) localLink.setAttribute("href", localRepository.href);
    } else localLink.removeAttribute("href");
  }

  function schedule() {
    if (scheduled || disposed) return;
    scheduled = true;
    win.queueMicrotask(() => { scheduled = false; update(); });
  }
  const Observer = win.MutationObserver;
  const modeObserver = Observer ? new Observer(schedule) : null;
  modeObserver?.observe(root, { attributes: true, attributeFilter: ["data-mobile-workspace", "lang"] });
  const contentObserver = Observer ? new Observer(() => {
    if (dialog.dataset.mobileCode === "true" && dialog.open) schedule();
  }) : null;
  contentObserver?.observe(dialog, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ["open", "hidden", "data-repository"] });
  dialog.addEventListener("click", schedule);
  dialog.addEventListener("toggle", schedule);
  update();
  return {
    update,
    dispose() {
      disposed = true;
      modeObserver?.disconnect(); contentObserver?.disconnect();
      dialog.removeEventListener("click", schedule); dialog.removeEventListener("toggle", schedule);
      delete dialog.dataset.mobileCode;
      delete dialog.dataset.mobileGithubStage;
      intro.remove(); note.remove(); localCard.remove();
    },
  };
}
