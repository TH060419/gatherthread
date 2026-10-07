# Product illustrations and real-interface captures

These assets accompany the [English product guide](../../PRODUCT_GUIDE.md) and [中文图文指南](../../PRODUCT_GUIDE.zh-CN.md).

## What the images show

- `cover.en.jpg` / `cover.zh-CN.jpg`: the approved white cover, combining the official GatherThread lockup with real desktop and phone screenshots.
- `collaboration.en.jpg` / `collaboration.zh-CN.jpg`: the approved collaboration schematic. The illustration represents shared discussion and file versions, people explicitly calling their own Agents, and human review. It is not a screenshot or a claim that automatic Agent teams exist.
- `en/annotated/` / `zh-CN/annotated/`: complete application-viewport captures with a separate layer of numbered thin outlines. Short explanations sit below, outside the captured interface. The interface is real; the people, conversation and Agent answers are demonstration content. `14-working-result.jpg` shows the existing example HTML after its real signup button was clicked, not a new model-generated result.
- `en/` / `zh-CN/`: two additional plain, uncropped screenshots per language for the desktop-and-phone cover.
- `gatherthread-lockup.svg`: the official light-background asset copied unchanged from `apps/web/brand/lockup-color-transparent-light.svg`.
- `collaboration-illustration.png`: AI-generated conceptual artwork, with exact labels added separately in the editable HTML.

## Provenance

Application source: `main` commit `ee540236a22f158424d718ff099cb82d26e4a54d`. Captures made on 2026-10-07, using the built app's `/app/example.html` with `locale=en` or `locale=zh-CN`, `theme=light`, and `topic=browse`. No production accounts, private conversations, credentials, real model calls or remote repositories were used.

Capture viewports: desktop 1440×1000, phone 390×844, tablet 820×1180, all at 2× pixel density. Phone/tablet contexts use their corresponding device layout and touch settings. Every guide image preserves the complete viewport and original aspect ratio. The numbered frames are documentation annotations, not application controls. This is Chrome capture evidence, not native Safari certification.

Export: annotated screenshots are JPEG at quality 88 with 4:4:4 chroma, capped at 2400 pixels wide without enlargement; phone images remain 780 pixels wide. Plain cover screenshots are capped at 2000 pixels. Poster exports are 2400×1500 JPEG at quality 91 with 4:4:4 chroma. Rendered-image metadata is stripped by the export pipeline. Raw captures and review boards remain local ignored artifacts, not duplicate repository assets.

## Editing the annotations

`source/annotations.mjs` maps each screenshot's short labels to actual interface selectors. `source/capture-geometry.en.json` and `.zh-CN.json` record the measured visible bounds at capture time. `source/annotation-page.mjs` renders those bounds as an SVG overlay above a separate, unchanged screenshot image, followed by the numbered legend. Badge positions are reviewed to avoid covering adjacent controls. If the interface changes, recapture and remeasure instead of reusing stale coordinates. Keep all screenshot pixels intact, and never generate or repaint interface text or controls.

## Editing the posters

The four HTML files and shared CSS in `source/` are the editable master files. Their composition and typography were developed with Designly and refined after the A/C direction review. Open an HTML file in a browser at 1600×1000; it waits for all images and fonts through `window.__ready`. Export at 1.5× device scale for the published size. Preserve the screenshots' content and the logo's proportions. Do not use generated artwork to fabricate application controls.

If the application changes, capture its example again in both languages, check captions against the visible state, rerender both posters, and inspect the compressed exports before replacing these files. Keep fictional content visibly identified as example content.
