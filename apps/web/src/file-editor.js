import { basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LanguageDescription, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { MergeView } from "@codemirror/merge";

// Source text stays in this browser view; language packs are bundled locally.
const appearance = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent", color: "var(--ink)" },
  ".cm-scroller": { overflow: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", lineHeight: "1.65" },
  ".cm-content": { padding: "12px 0" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--muted)", borderRightColor: "var(--line)" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--teal) 8%, transparent)" },
  ".cm-cursor": { borderLeftColor: "var(--ink)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "#73bdbd55" },
  ".cm-panels, .cm-tooltip": { backgroundColor: "var(--paper-raised)", color: "var(--ink)", borderColor: "var(--line)" },
});

async function languageFor(path) {
  const description = LanguageDescription.matchFilename(languages, path ?? "");
  return description ? description.load() : [];
}

export async function createFileEditor({ parent, doc = "", readOnly = false, onChange = () => {}, path, t = text => text }) {
  const permission = new Compartment();
  const support = await languageFor(path);
  const extensions = [basicSetup, appearance, syntaxHighlighting(defaultHighlightStyle), support,
    permission.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    EditorView.contentAttributes.of({ "aria-label": t("File contents"), spellcheck: "false", autocapitalize: "off" }),
    EditorView.updateListener.of(update => { if (update.docChanged) onChange(update.state.doc.toString()); })];
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions }) });
  return {
    getValue: () => view.state.doc.toString(),
    setValue(value) { if (value !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); },
    setReadOnly(value) { view.dispatch({ effects: permission.reconfigure([EditorState.readOnly.of(value), EditorView.editable.of(!value)]) }); },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

export async function createFileDiff({ parent, before = "", after = "", path, t = text => text }) {
  const support = await languageFor(path);
  const extensions = [basicSetup, appearance, syntaxHighlighting(defaultHighlightStyle), support,
    EditorState.readOnly.of(true), EditorView.editable.of(false)];
  const view = new MergeView({ parent, a: { doc: before, extensions: [...extensions,
    EditorView.contentAttributes.of({ "aria-label": t("Before changes") })] },
  b: { doc: after, extensions: [...extensions, EditorView.contentAttributes.of({ "aria-label": t("After changes") })] },
  highlightChanges: true, gutter: true, collapseUnchanged: { margin: 3, minSize: 8 }, diffConfig: { scanLimit: 1000 } });
  return { destroy: () => view.destroy() };
}
