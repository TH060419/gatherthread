function beijingDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

export function projectInvitationShareText(secret, invitation) {
  if (!secret) throw new TypeError("Invitation secret is unavailable");
  const startsAt = beijingDateTime(invitation?.createdAt);
  const expiresAt = beijingDateTime(invitation?.expiresAt);
  return [
    `邀请密钥：${secret}`,
    "登录共序后，在工作页右侧栏的「加入其他项目」中输入上述密钥，即可加入我的项目。首次使用时，也可在登录页选择「加入受邀项目」。",
    startsAt && expiresAt
      ? `有效期：${startsAt} 至 ${expiresAt}（北京时间）`
      : "有效期：请向邀请者确认（服务器未提供有效时间）。",
  ].join("\n");
}
