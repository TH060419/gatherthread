function calendarDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function calendarDayKey(value) {
  const date = calendarDate(value);
  if (!date) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function formatTimelineDay(value, locale, now = new Date()) {
  const date = calendarDate(value);
  const today = calendarDate(now);
  if (!date || !today) return null;
  const language = locale === "zh-CN" ? "zh-CN" : "en";
  const dayNumber = (day) => Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) / 86_400_000;
  const daysAgo = dayNumber(today) - dayNumber(date);
  if (daysAgo === 0) return language === "zh-CN" ? "今天" : "Today";
  if (daysAgo === 1) return language === "zh-CN" ? "昨天" : "Yesterday";
  if (daysAgo > 1 && daysAgo < 7) {
    return new Intl.DateTimeFormat(language, { weekday: "long" }).format(date);
  }
  const includeYear = date.getFullYear() !== today.getFullYear();
  if (language === "zh-CN") {
    return `${includeYear ? `${date.getFullYear()}年` : ""}${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return new Intl.DateTimeFormat(language, {
    ...(includeYear ? { year: "numeric" } : {}),
    month: "short",
    day: "numeric",
  }).format(date);
}

export function formatFullTimestamp(value, locale) {
  const date = calendarDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en", {
    dateStyle: "full",
    timeStyle: "short",
  }).format(date);
}
