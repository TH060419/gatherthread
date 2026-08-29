const FRAME_INTERVAL_MS = 50;
const DRIFT_SPEED_MULTIPLIER = 4.8;
const AMBIENT_BREATH_DEPTH = Object.freeze({ subtle: 0.07, pronounced: 0.13 });
const AUTH_ORBIT_SPEED_MULTIPLIER = 1.45;
const AMBIENT_STRENGTH = Object.freeze({
  light: Object.freeze({ subtle: 0.96, pronounced: 1.84 }),
  dark: Object.freeze({ subtle: 1, pronounced: 1.75 }),
});
const AMBIENT_PALETTES = Object.freeze({
  light: Object.freeze([
    { x: 0.82, y: 0.05, radius: 0.44, rgb: "255, 239, 207", alpha: 0.17, speed: 0.000019, phase: 4.7 },
    { x: 0.1, y: 0.22, radius: 0.42, rgb: "249, 221, 166", alpha: 0.13, speed: 0.000034, phase: 0.2 },
    { x: 0.48, y: 0.5, radius: 0.4, rgb: "253, 232, 193", alpha: 0.11, speed: 0.000028, phase: 1.9 },
    { x: 0.9, y: 0.84, radius: 0.48, rgb: "246, 211, 150", alpha: 0.09, speed: 0.000022, phase: 3.4 },
  ]),
  dark: Object.freeze([
    { x: 0.08, y: 0.12, radius: 0.4, rgb: "91, 218, 176", alpha: 0.2, speed: 0.000034, phase: 0.2 },
    { x: 0.48, y: 0.42, radius: 0.38, rgb: "91, 188, 220", alpha: 0.15, speed: 0.000028, phase: 1.9 },
    { x: 0.88, y: 0.78, radius: 0.44, rgb: "139, 126, 226", alpha: 0.13, speed: 0.000022, phase: 3.4 },
    { x: 0.76, y: 0.08, radius: 0.34, rgb: "205, 125, 190", alpha: 0.09, speed: 0.000019, phase: 4.7 },
  ]),
});
const AUTH_ORBITS = Object.freeze([
  Object.freeze({ x: 0.58, y: 0.18, radiusX: 0.17, radiusY: 0.28, rotation: -0.22, speed: 0.00019, phase: 0.4, arc: 1.42 }),
  Object.freeze({ x: 0.54, y: 0.82, radiusX: 0.22, radiusY: 0.2, rotation: 0.18, speed: -0.00015, phase: 2.8, arc: 1.16 }),
  Object.freeze({ x: 0.13, y: 0.76, radiusX: 0.13, radiusY: 0.24, rotation: -0.38, speed: 0.00013, phase: 4.9, arc: 0.94 }),
]);

export function createAmbientCanvas(canvas, environment = globalThis) {
  if (!canvas?.getContext) return { apply() {}, dispose() {} };
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) return { apply() {}, dispose() {} };

  const reducedMotionMedia = environment.matchMedia?.("(prefers-reduced-motion: reduce)");
  const darkSchemeMedia = environment.matchMedia?.("(prefers-color-scheme: dark)");
  let intensity = "off";
  let theme = "system";
  let frameId = 0;
  let lastFrame = 0;
  let width = 0;
  let height = 0;
  let pixelRatio = 1;

  const paletteName = () => theme === "dark" || (theme === "system" && darkSchemeMedia?.matches) ? "dark" : "light";
  const isAuthScene = () => Boolean(environment.document?.querySelector?.(".auth-shell:not([hidden])"));

  const resize = () => {
    width = Math.max(1, environment.innerWidth ?? canvas.clientWidth ?? 1);
    height = Math.max(1, environment.innerHeight ?? canvas.clientHeight ?? 1);
    pixelRatio = Math.min(2, Math.max(1, environment.devicePixelRatio ?? 1));
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  };

  const shouldAnimate = () => intensity !== "off"
    && !reducedMotionMedia?.matches
    && environment.document?.documentElement?.dataset.motion !== "reduce"
    && environment.document?.visibilityState !== "hidden";

  const drawAuthOrbits = (time, activePalette, strength) => {
    const storyWidth = width * 0.625;
    const lineRgb = activePalette === "dark" ? "34, 104, 95" : "241, 218, 176";
    const pointRgb = activePalette === "dark" ? "30, 130, 116" : "255, 226, 164";
    const orbitStrength = intensity === "pronounced" ? 1 : 0.64;
    context.save();
    context.globalCompositeOperation = activePalette === "dark" ? "multiply" : "screen";
    for (const [index, orbit] of AUTH_ORBITS.entries()) {
      const centerX = width * orbit.x;
      const centerY = height * orbit.y;
      const radiusX = Math.max(72, storyWidth * orbit.radiusX);
      const radiusY = Math.max(92, height * orbit.radiusY);
      const angle = time * orbit.speed * AUTH_ORBIT_SPEED_MULTIPLIER + orbit.phase;
      const trailStart = angle - orbit.arc;
      const orbitAlpha = Math.min(0.26, (0.075 + index * 0.018) * orbitStrength * strength);
      const trailGradient = context.createLinearGradient(
        centerX - radiusX,
        centerY - radiusY,
        centerX + radiusX,
        centerY + radiusY,
      );
      trailGradient.addColorStop(0, `rgba(${lineRgb}, 0)`);
      trailGradient.addColorStop(0.56, `rgba(${lineRgb}, ${orbitAlpha * 0.45})`);
      trailGradient.addColorStop(1, `rgba(${lineRgb}, ${orbitAlpha})`);
      context.beginPath();
      context.ellipse(centerX, centerY, radiusX, radiusY, orbit.rotation, trailStart, angle);
      context.strokeStyle = trailGradient;
      context.lineWidth = intensity === "pronounced" ? 1.35 : 0.9;
      context.stroke();

      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const rotationCos = Math.cos(orbit.rotation);
      const rotationSin = Math.sin(orbit.rotation);
      const pointX = centerX + radiusX * cos * rotationCos - radiusY * sin * rotationSin;
      const pointY = centerY + radiusX * cos * rotationSin + radiusY * sin * rotationCos;
      const pulse = 1 + Math.sin(time * 0.0022 + index * 1.7) * 0.18;
      const haloRadius = (intensity === "pronounced" ? 18 : 12) * pulse;
      const halo = context.createRadialGradient(pointX, pointY, 0, pointX, pointY, haloRadius);
      halo.addColorStop(0, `rgba(${pointRgb}, ${Math.min(0.9, 0.55 * orbitStrength * strength)})`);
      halo.addColorStop(0.22, `rgba(${pointRgb}, ${Math.min(0.5, 0.24 * orbitStrength * strength)})`);
      halo.addColorStop(1, `rgba(${pointRgb}, 0)`);
      context.fillStyle = halo;
      context.beginPath();
      context.arc(pointX, pointY, haloRadius, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  };

  const draw = (time) => {
    frameId = 0;
    if (!shouldAnimate()) {
      context.clearRect(0, 0, width, height);
      return;
    }
    if (time - lastFrame < FRAME_INTERVAL_MS) {
      frameId = environment.requestAnimationFrame(draw);
      return;
    }
    lastFrame = time;
    context.clearRect(0, 0, width, height);
    const activePalette = paletteName();
    const strength = AMBIENT_STRENGTH[activePalette]?.[intensity] ?? 1;
    const palette = AMBIENT_PALETTES[activePalette];
    const breathDepth = AMBIENT_BREATH_DEPTH[intensity] ?? 0;
    for (const [index, light] of palette.entries()) {
      const driftPhase = time * light.speed * DRIFT_SPEED_MULTIPLIER + light.phase;
      const breathPhase = time * (0.00042 + index * 0.000037) + light.phase * 1.37;
      const breath = Math.sin(breathPhase);
      const opacityPulse = 1 + breath * breathDepth;
      const radiusPulse = 1 + breath * breathDepth * 0.24;
      const centerX = width * (light.x + Math.sin(driftPhase) * 0.055);
      const centerY = height * (light.y + Math.cos(driftPhase * 0.82) * 0.042);
      const radius = Math.max(width, height) * light.radius * radiusPulse;
      const gradient = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
      gradient.addColorStop(0, `rgba(${light.rgb}, ${Math.min(0.72, light.alpha * strength * opacityPulse)})`);
      gradient.addColorStop(0.5, `rgba(${light.rgb}, ${Math.min(0.38, light.alpha * 0.4 * strength * (1 + breath * breathDepth * 0.7))})`);
      gradient.addColorStop(1, `rgba(${light.rgb}, 0)`);
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);
    }
    const authScene = isAuthScene();
    if (authScene) drawAuthOrbits(time, activePalette, strength);
    canvas.dataset.scene = authScene ? "auth" : "workspace";
    frameId = environment.requestAnimationFrame(draw);
  };

  const schedule = () => {
    if (frameId || !shouldAnimate()) return;
    resize();
    frameId = environment.requestAnimationFrame(draw);
  };
  const stop = () => {
    if (frameId) environment.cancelAnimationFrame(frameId);
    frameId = 0;
    context.clearRect(0, 0, width, height);
  };
  const handleEnvironmentChange = () => {
    canvas.dataset.palette = paletteName();
    shouldAnimate() ? schedule() : stop();
  };

  environment.addEventListener?.("resize", resize, { passive: true });
  environment.document?.addEventListener?.("visibilitychange", handleEnvironmentChange);
  reducedMotionMedia?.addEventListener?.("change", handleEnvironmentChange);
  darkSchemeMedia?.addEventListener?.("change", handleEnvironmentChange);

  return {
    apply(settings) {
      const requested = settings?.appearance?.ambientCanvas;
      intensity = requested === "subtle" || requested === "pronounced" ? requested : "off";
      theme = ["light", "dark", "system"].includes(settings?.appearance?.theme) ? settings.appearance.theme : "system";
      canvas.hidden = intensity === "off";
      canvas.dataset.active = String(intensity !== "off");
      canvas.dataset.intensity = intensity;
      handleEnvironmentChange();
    },
    dispose() {
      stop();
      environment.removeEventListener?.("resize", resize);
      environment.document?.removeEventListener?.("visibilitychange", handleEnvironmentChange);
      reducedMotionMedia?.removeEventListener?.("change", handleEnvironmentChange);
      darkSchemeMedia?.removeEventListener?.("change", handleEnvironmentChange);
    },
  };
}
