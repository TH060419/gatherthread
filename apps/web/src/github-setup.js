/** Presentation only. Server and connector permission checks remain authoritative. */
export function repositoryParts(repository = "") {
  const [owner = "", name = ""] = repository.split("/");
  return { owner, name };
}
export function repositoryFromFields(owner, name) {
  return `${owner.trim()}/${name.trim()}`;
}
export function newRepositoryUrl(name = "") {
  const url = new URL("https://github.com/new");
  if (/^[A-Za-z0-9_.-]{1,100}$/u.test(name) && name !== "." && name !== "..") url.searchParams.set("name", name);
  return url.href;
}
export function fillRepositoryFields(el, prefix, repository) {
  const { owner, name } = repositoryParts(repository);
  el(`${prefix}-repository`).value = repository;
  el(`${prefix}-owner`).value = owner;
  el(`${prefix}-name`).value = name;
}
export function bindRepositoryFields(el, prefix) {
  const update = () => {
    el(`${prefix}-repository`).value = repositoryFromFields(el(`${prefix}-owner`).value, el(`${prefix}-name`).value);
    el(`${prefix}-create`).href = newRepositoryUrl(el(`${prefix}-name`).value);
  };
  for (const part of ["owner", "name"]) el(`${prefix}-${part}`).addEventListener("input", update);
  return update;
}
export function mountGithubMode({ document: doc }) {
  const el = id => doc.getElementById(id);
  function select(mode) {
    el("code-github-panel").dataset.githubMode = mode;
    for (const value of ["cloud", "local"]) el(`github-mode-${value}`).setAttribute("aria-pressed", String(mode === value));
  }
  for (const mode of ["cloud", "local"]) el(`github-mode-${mode}`).addEventListener("click", () => select(mode));
  select("cloud");
  return { select };
}
