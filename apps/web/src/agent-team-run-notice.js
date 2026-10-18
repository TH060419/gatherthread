/** Requester-private Team feedback remains visible while its dialog is closed. */
export function mountTeamRunNotice({ host, message, advice, button, getNotice, openRecords, t = value => value, fallbackFocus }) {
  host.setAttribute("data-i18n-skip", "");
  button.addEventListener("click", () => openRecords());
  const put = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  return { update() {
    const notice = getNotice();
    host.hidden = !notice;
    if (!notice) {
      put(message, ""); put(advice, ""); delete host.dataset.runId;
      if (host.ownerDocument?.activeElement === button) fallbackFocus?.focus({ preventScroll: true });
      return;
    }
    // Keep live-region text stable across polling; never insert model HTML or
    // provider exception messages into this authenticated status surface.
    put(message, notice.text); put(advice, notice.advice ?? "");
    advice.hidden = !notice.advice;
    put(button, t("View run records"));
    if (notice.runId) host.dataset.runId = notice.runId; else delete host.dataset.runId;
  } };
}
