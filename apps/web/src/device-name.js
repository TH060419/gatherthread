export function automaticDeviceName(navigatorLike = globalThis.navigator) {
  const userAgent = String(navigatorLike?.userAgent ?? "");
  const uaPlatform = String(navigatorLike?.userAgentData?.platform ?? "");
  const legacyPlatform = String(navigatorLike?.platform ?? "");
  const platformSource = `${uaPlatform} ${legacyPlatform} ${userAgent}`;

  const platform = detectPlatform(platformSource);
  const browser = detectBrowser(userAgent, navigatorLike?.userAgentData?.brands);
  if (browser && platform) return `${browser} · ${platform}`;
  return browser || platform || "This browser";
}

function detectPlatform(value) {
  if (/iPad/i.test(value) || (/Macintosh/i.test(value) && /Mobile/i.test(value))) return "iPad";
  if (/iPhone|iPod/i.test(value)) return "iPhone";
  if (/Android/i.test(value)) return "Android";
  if (/CrOS/i.test(value)) return "ChromeOS";
  if (/Windows|Win32|Win64/i.test(value)) return "Windows";
  if (/Macintosh|MacIntel|macOS/i.test(value)) return "macOS";
  if (/Linux/i.test(value)) return "Linux";
  return "";
}

function detectBrowser(userAgent, brands = []) {
  const brandNames = Array.isArray(brands)
    ? brands.map((entry) => String(entry?.brand ?? "")).join(" ")
    : "";
  const source = `${brandNames} ${userAgent}`;
  if (/Microsoft Edge|Edg(?:A|iOS)?\//i.test(source)) return "Edge";
  if (/Opera|OPR\//i.test(source)) return "Opera";
  if (/Firefox|FxiOS/i.test(source)) return "Firefox";
  if (/Google Chrome|Chrome|CriOS/i.test(source)) return "Chrome";
  if (/Safari/i.test(source) && /Version\//i.test(source)) return "Safari";
  return "";
}
