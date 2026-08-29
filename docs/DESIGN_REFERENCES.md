# Design references and tooling

GatherThread's interface is original application code. No third-party visual component source is bundled by this redesign.

The following open-source projects were used as design-process references or reusable local tooling:

- [Taste Skill](https://github.com/Leonxlnx/taste-skill), MIT: interface critique, anti-slop checks, and redesign discipline.
- [Huashu Design](https://github.com/alchaincyf/huashu-design), MIT: reference-led design workflow and visual QA guidance.
- [OpenPencil](https://github.com/ZSeven-W/openpencil), MIT: local design tooling installed for future mockups and design-file review.
- [design.md](https://github.com/google-labs-code/design.md), Apache-2.0: the structured `DESIGN.md` format and linter.
- [Canvas UI](https://github.com/DavidHDev/canvas-ui), MIT with Commons Clause: reviewed as an effect catalogue. GatherThread does not copy or redistribute its component implementations; the optional ambient canvas is an independent, dependency-free implementation suited to this product.

The Canvas UI shadcn MCP registry is installed globally as a discovery tool for future projects. Adding a registry component to GatherThread requires a separate source review, license check, attribution update, and performance/accessibility test.
