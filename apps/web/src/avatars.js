import { initials } from "./domain.js";

const svgImage = (content) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">${content}</svg>`)}`;
const face = (background, fur, ears, detail = "") => svgImage(
  `<rect width="80" height="80" rx="20" fill="${background}"/>${ears}<ellipse cx="40" cy="46" rx="25" ry="24" fill="${fur}"/><circle cx="31" cy="42" r="2.5" fill="#253442"/><circle cx="49" cy="42" r="2.5" fill="#253442"/><ellipse cx="40" cy="53" rx="10" ry="7" fill="#fff4e7"/><path d="M37 50h6l-3 4z" fill="#253442"/><path d="M40 54v3" stroke="#253442" stroke-width="2"/>${detail}`,
);

// Original temporary artwork. Replace these reviewed image sources with the
// team's official images while keeping IDs stable. No user-supplied image URL.
// Data images also keep the sandboxed onboarding example self-contained.
export const AVATAR_CATALOG = Object.freeze([
  { id: "cat", label: "Cat", image: face("#dceee9", "#e9b969", '<path d="M18 37V13l20 15M62 37V13L42 28" fill="#e9b969"/>', '<path d="M19 49h12m-11 7 11-2m18-5h12m-12 5 11 2" stroke="#805e35" stroke-width="1.5"/>') },
  { id: "fox", label: "Fox", image: face("#f7e7d9", "#e79054", '<path d="m17 36 4-25 19 19m23 6-4-25-19 19" fill="#e79054"/>', '<path d="m21 45 19 13 19-13-9 20H30z" fill="#fff4e7"/><circle cx="40" cy="53" r="3" fill="#253442"/>') },
  { id: "bear", label: "Bear", image: face("#e7e1f1", "#ac8b72", '<circle cx="21" cy="24" r="11" fill="#ac8b72"/><circle cx="59" cy="24" r="11" fill="#ac8b72"/>') },
  { id: "rabbit", label: "Rabbit", image: face("#f5e0e5", "#fff5ed", '<ellipse cx="28" cy="23" rx="8" ry="20" fill="#fff5ed"/><ellipse cx="52" cy="23" rx="8" ry="20" fill="#fff5ed"/><ellipse cx="28" cy="20" rx="3" ry="12" fill="#eab3bd"/><ellipse cx="52" cy="20" rx="3" ry="12" fill="#eab3bd"/>') },
  { id: "penguin", label: "Penguin", image: face("#dce9f7", "#3c5367", '', '<ellipse cx="40" cy="46" rx="18" ry="19" fill="#fff5ed"/><circle cx="32" cy="42" r="2.5" fill="#253442"/><circle cx="48" cy="42" r="2.5" fill="#253442"/><path d="m35 51 5 6 5-6z" fill="#e9b969"/>') },
  { id: "owl", label: "Owl", image: face("#f0edd3", "#8f9c74", '<path d="m18 35-3-20 25 13 25-13-3 20" fill="#8f9c74"/>', '<circle cx="30" cy="43" r="10" fill="#fff5ed"/><circle cx="50" cy="43" r="10" fill="#fff5ed"/><circle cx="30" cy="43" r="3" fill="#253442"/><circle cx="50" cy="43" r="3" fill="#253442"/><path d="m36 52 4 6 4-6z" fill="#e9b969"/>') },
]);

const robotImage = svgImage('<rect x="2" y="2" width="76" height="76" rx="24" fill="#fff5d6"/><path d="M40 15v10" stroke="#75531f" stroke-width="5"/><circle cx="40" cy="13" r="5" fill="#75531f"/><rect x="16" y="25" width="48" height="38" rx="12" fill="#75531f"/><circle cx="30" cy="41" r="4" fill="#fff5d6"/><circle cx="50" cy="41" r="4" fill="#fff5d6"/><path d="M30 53h20" stroke="#fff5d6" stroke-width="3"/>');
export const avatarImage = (id) => AVATAR_CATALOG.find((entry) => entry.id === id)?.image ?? null;
export const isAgentReply = (event) => event?.type === "agent_response";
export function eventAuthorLabel(event, translate = (text) => text) {
  const name = event?.actor?.username ?? "";
  return isAgentReply(event) ? translate("{name}'s Agent").replace("{name}", () => name) : name;
}

export function renderAvatar(document, node, { userId, username = "", avatarId = null, agent = false, harness = "" } = {}) {
  node.classList.add("avatar");
  node.classList.toggle("avatar-agent", agent);
  node.replaceChildren();
  node.setAttribute("aria-hidden", "true");
  const fallback = document.createElement("span");
  fallback.className = "avatar-fallback";
  fallback.textContent = userId === "deleted-account" ? "·" : initials(username);
  node.append(fallback);
  const image = userId === "deleted-account" ? null : avatarImage(avatarId);
  if (image) {
    const img = document.createElement("img");
    img.className = "avatar-image";
    img.alt = "";
    img.addEventListener("load", () => { fallback.hidden = true; }, { once: true });
    img.addEventListener("error", () => { fallback.hidden = false; img.remove(); }, { once: true });
    img.src = image;
    node.append(img);
  }
  if (agent) {
    const badge = document.createElement("span");
    badge.className = "avatar-agent-badge";
    badge.dataset.harness = harness;
    const img = document.createElement("img");
    img.src = robotImage;
    img.alt = "";
    badge.append(img);
    node.append(badge);
  }
  return node;
}
