function beijingDateTime(value, locale) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const formatter = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  if (locale !== "en") return formatter.format(date);
  const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function projectInvitationShareText(secret, invitation, locale = "zh-CN") {
  if (!secret) throw new TypeError("Invitation secret is unavailable");
  const startsAt = beijingDateTime(invitation?.createdAt, locale);
  const expiresAt = beijingDateTime(invitation?.expiresAt, locale);
  if (locale === "en") {
    return [
      `Invitation secret: ${secret}`,
      "Sign in to GatherThread, then enter this secret under “Join another project” in the right sidebar to join my project. First-time users can also choose “Join an invited project” on the sign-in page.",
      startsAt && expiresAt
        ? `Valid: ${startsAt} to ${expiresAt} (China Standard Time)`
        : "Valid: Please confirm with the inviter (the server did not provide the validity period).",
    ].join("\n");
  }
  return [
    `邀请密钥：${secret}`,
    "登录共序后，在工作页右侧栏的「加入其他项目」中输入上述密钥，即可加入我的项目。首次使用时，也可在登录页选择「加入受邀项目」。",
    startsAt && expiresAt
      ? `有效期：${startsAt} 至 ${expiresAt}（北京时间）`
      : "有效期：请向邀请者确认（服务器未提供有效时间）。",
  ].join("\n");
}
