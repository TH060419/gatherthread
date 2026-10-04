/** PR62 provider seam: pass this transport to its existing ResendRegistrationMailer.
 * No account/OTP logic is duplicated. This wrapper only labels outgoing test mail.
 */
export function testEmailTransport(origin: string, transport: typeof fetch = fetch): typeof fetch {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin || origin === "https://gatherthread.cn") throw new Error("Test mail requires an isolated HTTPS origin");
  return async (input, init) => {
    if (input !== "https://api.resend.com/emails" || init?.method !== "POST" || typeof init.body !== "string") throw new Error("Unexpected test mail transport request");
    const body = JSON.parse(init.body) as { subject?: unknown; text?: unknown };
    if (typeof body.subject !== "string" || typeof body.text !== "string") throw new Error("Unexpected test mail format");
    body.subject = `[测试环境 / TEST] ${body.subject}`;
    body.text = `测试环境 / Test environment: ${origin}/app/\n测试账号与正式账号独立 / Test accounts are separate from production.\n\n${body.text}`;
    return transport(input, { ...init, body: JSON.stringify(body) });
  };
}
