// Never show login before the server has checked its HttpOnly session.
// No identity, credential or authentication decision is cached on the client.
try {
  await import("./main.js?v=20261010-workspace-1");
} catch {
  document.documentElement.dataset.bootState = "failed";
  const screen = document.getElementById("boot-screen");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "button button-secondary";
  retry.textContent = /^zh/i.test(navigator.language) ? "重新加载" : "Reload";
  retry.addEventListener("click", () => location.reload());
  screen.replaceChildren(retry);
}
