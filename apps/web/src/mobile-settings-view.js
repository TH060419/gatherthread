// A presentation layer over the existing form. Hidden desktop values stay intact.
export const MOBILE_SETTINGS_SECTIONS = Object.freeze([
  "settings-general", "settings-profile", "settings-appearance", "settings-composer",
  "settings-notifications", "settings-summaries", "settings-device", "settings-account",
]);

export function mountMobileSettings({ document: doc, window: win, t, isMobile }) {
  const dialog = doc.getElementById("settings-dialog");
  const navigation = dialog.querySelector(".settings-navigation");
  const sections = [...dialog.querySelectorAll(".settings-section")];
  const back = doc.createElement("button");
  back.type = "button";
  back.className = "mobile-settings-back";
  back.dataset.i18nSkip = "";
  dialog.querySelector(".settings-header").prepend(back);
  let selected = null;
  let wasMobile = false;
  function render() {
    const mobile = isMobile();
    const enteringMobile = mobile && !wasMobile;
    const focusedSection = doc.activeElement?.closest?.(".settings-section");
    if (enteringMobile && dialog.open && MOBILE_SETTINGS_SECTIONS.includes(focusedSection?.id)) selected = focusedSection.id;
    wasMobile = mobile;
    dialog.dataset.mobileSettings = String(mobile);
    if (!mobile) selected = null;
    dialog.dataset.settingsPage = selected ?? "home";
    back.textContent = `‹ ${t("Settings")}`;
    back.hidden = !mobile || !selected;
    navigation.setAttribute("aria-label", t("Settings sections"));
    for (const link of navigation.querySelectorAll("a")) {
      const id = link.hash.slice(1);
      link.classList.toggle("mobile-setting-unavailable", !MOBILE_SETTINGS_SECTIONS.includes(id));
    }
    for (const section of sections) {
      section.classList.toggle("mobile-setting-unavailable", !MOBILE_SETTINGS_SECTIONS.includes(section.id));
      section.classList.toggle("mobile-setting-selected", selected === section.id);
    }
    if (enteringMobile && dialog.open && focusedSection && !MOBILE_SETTINGS_SECTIONS.includes(focusedSection.id)) {
      navigation.tabIndex = -1;
      navigation.focus({ preventScroll: true });
    }
  }
  function show(id, focus = true) {
    if (!isMobile()) return;
    selected = MOBILE_SETTINGS_SECTIONS.includes(id) ? id : null;
    render();
    dialog.querySelector(".settings-layout").scrollTop = 0;
    dialog.querySelector(".settings-sections").scrollTop = 0;
    dialog.scrollTop = 0;
    if (focus) {
      const target = selected ? doc.getElementById(selected) : navigation;
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  }
  navigation.addEventListener("click", event => {
    if (!isMobile()) return;
    const link = event.target.closest("a[href^='#']");
    if (!link) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    show(link.hash.slice(1));
  }, true);
  back.addEventListener("click", () => show(null));
  // Native form validation must reveal the original field before focusing it.
  dialog.addEventListener("invalid", event => {
    if (isMobile()) show(event.target.closest(".settings-section")?.id, false);
  }, true);
  dialog.addEventListener("close", () => { selected = null; render(); });
  const observer = new win.MutationObserver(render);
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-mobile-workspace", "lang"] });
  render();
  return { open: id => show(id, false), refresh: render };
}
