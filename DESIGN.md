---
version: alpha
name: GatherThread Quiet Workspace
description: A restrained, native-feeling collaboration interface for people and their local Agents.
colors:
  paper: "#F5F5F7"
  surface: "#FFFFFF"
  ink: "#1D1D1F"
  muted: "#68686D"
  primary: "#087F73"
  primary-strong: "#05665D"
  coral: "#E66A54"
  warning: "#9C650F"
  danger: "#B42318"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Display, Helvetica Neue, Segoe UI, sans-serif"
    fontSize: 28px
    fontWeight: 650
    lineHeight: 1.15
    letterSpacing: -0.03em
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Helvetica Neue, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, sans-serif"
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Helvetica Neue, Segoe UI, sans-serif"
    fontSize: 12px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: 0.04em
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  panel: 18px
rounded:
  sm: 8px
  md: 12px
  lg: 16px
  dialog: 24px
  full: 999px
components:
  app-shell:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
  primary-button:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
  primary-button-hover:
    backgroundColor: "{colors.primary-strong}"
    textColor: "{colors.surface}"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
  caption:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
  event-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
  agent-request-accent:
    backgroundColor: "{colors.coral}"
    textColor: "{colors.ink}"
  warning-status:
    backgroundColor: "{colors.warning}"
    textColor: "{colors.surface}"
  danger-action:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.surface}"
---

# GatherThread design system

## Overview

GatherThread is a working environment, not a marketing page. It should feel calm, precise, and native enough to disappear behind the collaboration. Information density is moderate, primary actions are obvious, and decorative effects never compete with canonical history or Agent state.

The visual-change target is 5/10, motion is 3/10, and information density is 6/10. The interface uses quiet neutral surfaces, one teal action color, and coral only where authorship or pending Agent work benefits from contrast.

## Colors

- **Paper:** cool near-white for the application background.
- **Surface:** white for the central conversation and focused controls.
- **Ink:** near-black for durable readability.
- **Primary teal:** collaboration, live state, and primary actions.
- **Coral:** human-authored Agent requests and limited attention cues.
- **Warning and danger:** reserved for degraded states and destructive actions.

Dark mode preserves the semantic roles rather than mechanically inverting colors. High-contrast mode strengthens dividers and muted copy, and disables decorative canvas motion.

## Typography

Use the operating-system UI stack. Simplified Chinese prefers PingFang SC and receives an 8% optical size correction so captions and controls do not become visually smaller than their English equivalents. Titles use a modestly tightened semi-bold weight; body copy remains neutral and readable; labels are compact and tabular metadata uses tabular numerals. Avoid novelty display fonts, excessive uppercase, and decorative gradients in text.

## Layout

Desktop uses three functional regions: sessions, canonical conversation, and members. The two side panels are user-resizable within safe bounds and collapse into existing responsive behavior below 1040 px. Spacing follows an 8 px rhythm with 4 px micro-adjustments.

Settings use a stable category rail and one scrollable content surface. Continuous numeric settings always provide both a preset and an exact input.

## Elevation & Depth

Hierarchy comes primarily from surface contrast and one-pixel dividers. Cards use a two-stage, low-opacity shadow and a one-pixel highlight to separate canonical content without feeling tiled. Optional ambient mode lets a slow, diffuse light field show through the top bar and side panels using restrained translucent materials; it never draws visible paths across the conversation content. Dialogs use the strongest elevation. Reduced-motion or reduced-transparency preferences remove decorative motion and blur.

## Shapes

Controls and event cards use 8-16 px radii. Full pills are limited to compact statuses, tags, and toggles. Avoid stacking rounded containers when whitespace and a divider communicate the same relationship.

## Components

- **Conversation events:** one stable card language with type-specific left accents and explicit authorship.
- **Buttons:** primary teal for the single forward action; neutral secondary buttons for alternatives; text buttons for low-emphasis actions.
- **Settings rows:** descriptive copy on the left and one bounded control group on the right.
- **Canvas environment:** optional and off by default. It renders a small set of low-frequency radial light fields behind application chrome, pauses in background tabs, and stops for reduced motion or high contrast. There are no paths or nodes that can cross labels. When enabled, chrome uses translucent, saturated material with a fine inner highlight without reducing text contrast.
- **Switches:** native semantic checkbox input and focus behavior with a separate visual track, avoiding browser-specific pseudo-element rendering on replaced inputs.
- **Motion:** use opacity and transform only, 120-180 ms for interaction feedback. No perpetual motion is allowed in the conversation surface except the bounded Agent answering indicator.

## Do's and Don'ts

Do preserve focus visibility, minimum target sizes, semantic landmarks, and the existing information architecture.

Do make current sync, permissions, model, and reasoning choices explicit.

Do keep credentials out of settings, URLs, DOM persistence, logs, and copied commands.

Do not use purple AI gradients, glowing cards, floating decorative blobs, or chat-bubble theatrics.

Do not let animation move layout, obscure content, imply false progress, or continue when the user requests reduced motion.

Do not translate user-authored content, model identifiers, GatherThread, Codex, token, harness, runtime, prompt, or canonical protocol identifiers.
