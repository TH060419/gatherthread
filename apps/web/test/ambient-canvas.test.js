import test from "node:test";
import assert from "node:assert/strict";

import { createAmbientCanvas } from "../src/ambient-canvas.js";

test("ambient canvas supports two strengths and stops for reduced motion", () => {
  let nextFrame = 0;
  let cancelledFrames = 0;
  let visibilityListener;
  const reducedMotionListeners = new Set();
  const schemeListeners = new Set();
  const reducedMotionMedia = {
    matches: false,
    addEventListener: (_name, listener) => reducedMotionListeners.add(listener),
    removeEventListener: (_name, listener) => reducedMotionListeners.delete(listener),
  };
  const darkSchemeMedia = {
    matches: false,
    addEventListener: (_name, listener) => schemeListeners.add(listener),
    removeEventListener: (_name, listener) => schemeListeners.delete(listener),
  };
  const context = {
    clearRect() {}, setTransform() {}, createRadialGradient: () => ({ addColorStop() {} }), fillRect() {},
  };
  const canvas = { hidden: true, dataset: {}, style: {}, clientWidth: 10, clientHeight: 10, getContext: () => context };
  const environment = {
    innerWidth: 1200,
    innerHeight: 800,
    devicePixelRatio: 2,
    document: {
      documentElement: { dataset: { motion: "system", contrast: "standard" } },
      visibilityState: "visible",
      addEventListener: (_name, listener) => { visibilityListener = listener; },
      removeEventListener() {},
    },
    matchMedia: (query) => query.includes("color-scheme") ? darkSchemeMedia : reducedMotionMedia,
    requestAnimationFrame: () => ++nextFrame,
    cancelAnimationFrame() { cancelledFrames += 1; },
    addEventListener() {},
    removeEventListener() {},
  };
  const controller = createAmbientCanvas(canvas, environment);
  controller.apply({ appearance: { ambientCanvas: "off" } });
  assert.equal(canvas.hidden, true);
  assert.equal(nextFrame, 0);
  controller.apply({ appearance: { ambientCanvas: "subtle" } });
  assert.equal(canvas.hidden, false);
  assert.equal(canvas.dataset.intensity, "subtle");
  assert.equal(canvas.dataset.palette, "light");
  assert.equal(nextFrame, 1);
  reducedMotionMedia.matches = true;
  for (const listener of reducedMotionListeners) listener();
  assert.equal(canvas.dataset.active, "true");
  assert.equal(cancelledFrames, 1);
  reducedMotionMedia.matches = false;
  environment.document.visibilityState = "hidden";
  visibilityListener();
  assert.equal(nextFrame, 1, "background tabs must not schedule new frames");
  environment.document.visibilityState = "visible";
  environment.document.documentElement.dataset.contrast = "high";
  visibilityListener();
  assert.equal(nextFrame, 2, "high contrast must preserve the ambient canvas");
  controller.apply({ appearance: { ambientCanvas: "pronounced" } });
  assert.equal(canvas.dataset.intensity, "pronounced");
  controller.apply({ appearance: { ambientCanvas: "pronounced", theme: "dark" } });
  assert.equal(canvas.dataset.palette, "dark");
  controller.apply({ appearance: { ambientCanvas: "pronounced", theme: "light" } });
  assert.equal(canvas.dataset.palette, "light");
  controller.dispose();
});

test("ambient canvas adds visible but restrained breathing and drift", () => {
  let scheduledFrame;
  const gradients = [];
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  const context = {
    clearRect() {},
    setTransform() {},
    createRadialGradient(...args) {
      const record = { args, stops: [] };
      gradients.push(record);
      return { addColorStop: (offset, color) => record.stops.push([offset, color]) };
    },
    fillRect() {},
  };
  const canvas = { hidden: true, dataset: {}, style: {}, clientWidth: 10, clientHeight: 10, getContext: () => context };
  const environment = {
    innerWidth: 1200,
    innerHeight: 800,
    devicePixelRatio: 1,
    document: {
      documentElement: { dataset: { motion: "full" } },
      visibilityState: "visible",
      addEventListener() {},
      removeEventListener() {},
    },
    matchMedia: () => media,
    requestAnimationFrame(callback) { scheduledFrame = callback; return 1; },
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {},
  };

  const controller = createAmbientCanvas(canvas, environment);
  controller.apply({ appearance: { ambientCanvas: "pronounced", theme: "light" } });
  scheduledFrame(1_000);
  const firstCenterColor = gradients[0].stops[0][1];
  const firstCenterX = gradients[0].args[0];
  const firstRadius = gradients[0].args[5];
  scheduledFrame(8_000);
  const secondCenterColor = gradients[4].stops[0][1];
  const secondCenterX = gradients[4].args[0];
  const secondRadius = gradients[4].args[5];

  assert.notEqual(firstCenterColor, secondCenterColor, "brightness should breathe within a few seconds");
  assert.notEqual(firstCenterX, secondCenterX, "the glow should visibly drift within a few seconds");
  assert.notEqual(firstRadius, secondRadius, "the glow radius should breathe with the brightness");
  controller.dispose();
});

test("login scene adds independent orbit trails and moving points", () => {
  let scheduledFrame;
  let orbitTrails = 0;
  let movingPoints = 0;
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  const context = {
    clearRect() {}, setTransform() {}, fillRect() {}, save() {}, restore() {}, beginPath() {},
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
    ellipse() { orbitTrails += 1; },
    stroke() {},
    arc() { movingPoints += 1; },
    fill() {},
  };
  const canvas = { hidden: true, dataset: {}, style: {}, clientWidth: 10, clientHeight: 10, getContext: () => context };
  const environment = {
    innerWidth: 1200,
    innerHeight: 800,
    devicePixelRatio: 1,
    document: {
      documentElement: { dataset: { motion: "full" } },
      visibilityState: "visible",
      querySelector: () => ({}),
      addEventListener() {},
      removeEventListener() {},
    },
    matchMedia: () => media,
    requestAnimationFrame(callback) { scheduledFrame = callback; return 1; },
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {},
  };

  const controller = createAmbientCanvas(canvas, environment);
  controller.apply({ appearance: { ambientCanvas: "pronounced", theme: "light" } });
  scheduledFrame(2_000);
  assert.equal(canvas.dataset.scene, "auth");
  assert.equal(orbitTrails, 3, "the cover should render three separate orbit trails");
  assert.equal(movingPoints, 3, "each trail should carry one moving point");
  controller.dispose();
});
