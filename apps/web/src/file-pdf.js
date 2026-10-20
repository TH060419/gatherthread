import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";

const MAX_PIXELS = 8_000_000;
const MAX_PAGES = 1000;

/** Canvas-only preview: never execute document actions, forms or embedded HTML. */
export async function createPdfPreview({ host, bytes, t = text => text }) {
  const doc = host.ownerDocument;
  if (doc.documentElement.dataset.example === "true") throw new Error(t("Download this PDF to view it outside the isolated demo."));
  const assets = new URL("./src/pdfjs/", doc.baseURI);
  GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.mjs", assets).href;
  const task = getDocument({ data: new Uint8Array(bytes), cMapUrl: new URL("cmaps/", assets).href, cMapPacked: true,
    standardFontDataUrl: new URL("standard_fonts/", assets).href, useWasm: false, enableXfa: false, disableFontFace: true,
    disableAutoFetch: true, disableStream: true, disableRange: true, isImageDecoderSupported: false,
    maxImageSize: MAX_PIXELS, canvasMaxAreaInBytes: MAX_PIXELS * 4, stopAtErrors: true });
  // Passwords are not retained or sent to any API. Encrypted documents can be downloaded.
  task.onPassword = () => { void task.destroy(); };
  let pdf;
  try { pdf = await task.promise; } catch { await task.destroy(); throw new Error(t("Cannot preview this PDF. Download it to open locally.")); }
  if (pdf.numPages > MAX_PAGES) { await task.destroy(); throw new Error(t("This PDF is too large to preview. Download it instead.")); }
  let page = 1, zoom = 1, revision = 0, renderTask, disposed = false;
  const root = doc.createElement("section"); root.className = "workspace-pdf";
  const toolbar = doc.createElement("div"); toolbar.className = "workspace-pdf-toolbar";
  const status = doc.createElement("span"); status.setAttribute("role", "status");
  const canvas = doc.createElement("canvas"); canvas.setAttribute("role", "img");
  const scroller = doc.createElement("div"); scroller.className = "workspace-pdf-pages"; scroller.append(canvas);
  const button = (label, act) => { const node = doc.createElement("button"); node.type = "button"; node.className = "button button-secondary";
    node.textContent = t(label); node.addEventListener("click", act); toolbar.append(node); return node; };
  const previous = button("Previous page", () => { page = Math.max(1, page - 1); void render(); });
  const next = button("Next page", () => { page = Math.min(pdf.numPages, page + 1); void render(); });
  toolbar.append(status);
  button("Zoom out", () => { zoom = Math.max(0.5, zoom - 0.25); void render(); });
  button("Zoom in", () => { zoom = Math.min(3, zoom + 0.25); void render(); });
  root.append(toolbar, scroller); host.append(root);
  async function render() {
    const token = ++revision; renderTask?.cancel();
    previous.disabled = page <= 1; next.disabled = page >= pdf.numPages;
    status.textContent = `${page} / ${pdf.numPages} · ${Math.round(zoom * 100)}%`;
    try {
      const pdfPage = await pdf.getPage(page);
      if (disposed || token !== revision) return;
      const base = pdfPage.getViewport({ scale: zoom });
      const ratio = Math.min(doc.defaultView.devicePixelRatio || 1, 2, Math.sqrt(MAX_PIXELS / (base.width * base.height)));
      const viewport = pdfPage.getViewport({ scale: zoom * ratio });
      canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${base.width}px`; canvas.style.height = `${base.height}px`;
      canvas.setAttribute("aria-label", `${t("PDF page")} ${page} / ${pdf.numPages}`);
      renderTask = pdfPage.render({ canvas, canvasContext: canvas.getContext("2d"), viewport });
      await renderTask.promise;
      pdfPage.cleanup();
    } catch (error) {
      if (!disposed && token === revision && error.name !== "RenderingCancelledException") status.textContent = t("Cannot preview this PDF. Download it to open locally.");
    }
  }
  await render();
  return { destroy() { disposed = true; revision++; renderTask?.cancel(); void task.destroy(); root.remove(); } };
}
