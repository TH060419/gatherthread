import { isIP } from "node:net";
import { z } from "zod";
import { RegistrationEmailSchema } from "@gatherthread/protocol";
import type { RegistrationChallenge, RegistrationMailer, RegistrationOptions } from "./registration.js";
import { testEmailTransport } from "./test-email-transport.js";

const ChallengeResult = z.object({ success: z.boolean(), hostname: z.string().optional(), action: z.string().optional(), cdata: z.string().optional() });
/** Provider responses/errors never enter logs or API replies. No redirect or unbounded retry. */
export class TurnstileRegistrationChallenge implements RegistrationChallenge {
  constructor(private readonly secret: string, private readonly hostname: string, private readonly transport: typeof fetch = fetch) {}
  async verify(token: string, binding: string, purpose: "registration" | "password-reset" = "registration"): Promise<boolean> {
    const response = await this.transport("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
      body: new URLSearchParams({ secret: this.secret, response: token }),
    });
    if (!response.ok) return false;
    const value = ChallengeResult.safeParse(await response.json());
    return value.success && value.data.success && value.data.hostname === this.hostname
      && value.data.action === (purpose === "registration" ? "gt_register" : "gt_password_reset") && value.data.cdata === binding;
  }
}
export class ResendRegistrationMailer implements RegistrationMailer {
  constructor(private readonly key: string, private readonly from: string, private readonly transport: typeof fetch = fetch) {}
  async send(message: Parameters<RegistrationMailer["send"]>[0]): Promise<void> {
    const zh = message.locale === "zh-CN";
    const reset = message.purpose === "password-reset";
    const subject = reset ? (zh ? "GatherThread 重设密码验证码" : "GatherThread password reset code") : (zh ? "GatherThread 注册验证码" : "GatherThread registration code");
    const text = reset
      ? (zh ? `您的重设密码验证码：${message.code}\n10 分钟内有效，请在请求验证码的浏览器填写。不要向他人分享。\n若您未请求重设密码，请忽略此邮件，您的密码不会改变。只有已有的邮箱账号才能重设密码。`
        : `Your password reset code: ${message.code}\nValid for 10 minutes in the browser that requested it. Do not share it.\nIf you did not request a reset, ignore this email. Your password has not changed. Only an existing email account can reset its password.`)
      : (zh ? `您的注册验证码：${message.code}\n10 分钟内有效，请在请求验证码的浏览器填写。不要向他人分享。\n若您未请求注册，请忽略此邮件。此验证码只能用于创建账号。`
        : `Your registration code: ${message.code}\nValid for 10 minutes in the browser that requested it. Do not share it.\nIf you did not request registration, ignore this email. This code can only create an account.`);
    await this.deliver(message.email, subject, text, `${reset ? "password-reset" : "registration"}-${message.deliveryId}`);
  }
  async notifyPasswordChanged(message: { email: string; locale: "en" | "zh-CN"; deliveryId: string }): Promise<void> {
    const zh = message.locale === "zh-CN";
    await this.deliver(message.email, zh ? "GatherThread 密码已重设" : "GatherThread password changed",
      zh ? "您的 GatherThread 密码已重设。所有已登录设备和 Agent 授权已撤销。请用新密码登录并重新授权自己的 Agent。若这不是您操作的，请立即重设密码并检查邮箱安全。"
        : "Your GatherThread password has changed. All signed-in devices and Agent authorizations have been revoked. Sign in with your new password and authorize your Agents again. If this was not you, reset your password immediately and secure your email account.",
      `password-changed-${message.deliveryId}`);
  }
  private async deliver(email: string, subject: string, text: string, deliveryId: string): Promise<void> {
    const response = await this.transport("https://api.resend.com/emails", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json", "idempotency-key": deliveryId },
      body: JSON.stringify({ from: this.from, to: [email], subject, text }),
    });
    // Do not parse the provider body, which may echo personal data or secrets.
    await response.body?.cancel();
    if (!response.ok) throw new Error("Registration mail delivery failed");
  }
}
/** No mock/console-mail option is exposed through environment configuration. */
export function registrationFromEnvironment(env: NodeJS.ProcessEnv, publicOrigin: string): RegistrationOptions {
  const raw = env.GATHERTHREAD_PUBLIC_REGISTRATION;
  if (raw !== undefined && raw !== "false" && raw !== "true") throw new Error("GATHERTHREAD_PUBLIC_REGISTRATION must be true or false");
  const recovery = env.GATHERTHREAD_PASSWORD_RECOVERY;
  if (recovery !== undefined && recovery !== "false" && recovery !== "true") throw new Error("GATHERTHREAD_PASSWORD_RECOVERY must be true or false");
  const proxy = env.GATHERTHREAD_REGISTRATION_TRUSTED_PROXY;
  if (proxy && !isIP(proxy)) throw new Error("Registration trusted proxy must be one exact IP address");
  const closed = (): RegistrationOptions => ({ enabled: false, recoveryEnabled: false, ...(proxy ? { trustedProxy: proxy } : {}) });
  if (raw !== "true" && recovery !== "true") return closed();
  const siteKey = env.GATHERTHREAD_TURNSTILE_SITE_KEY;
  const secret = env.GATHERTHREAD_TURNSTILE_SECRET;
  const key = env.GATHERTHREAD_REGISTRATION_RESEND_KEY;
  const from = RegistrationEmailSchema.safeParse(env.GATHERTHREAD_REGISTRATION_FROM);
  // Missing dependencies close email-code flows; password sign-in stays available.
  const origin = new URL(publicOrigin);
  if (origin.protocol !== "https:" || !siteKey || !secret || !key || !from.success) return closed();
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(siteKey) || secret.length < 20 || key.length < 20) return closed();
  return { enabled: raw === "true", recoveryEnabled: recovery === "true", origin: origin.origin, siteKey,
    mailer: new ResendRegistrationMailer(key, from.data, env.GATHERTHREAD_DEPLOYMENT_ENVIRONMENT === "test" ? testEmailTransport(origin.origin) : fetch),
    challenge: new TurnstileRegistrationChallenge(secret, origin.hostname),
    ...(proxy ? { trustedProxy: proxy } : {}),
  };
}

// Never accept arbitrary X-Forwarded-For. An explicitly trusted edge must REMOVE incoming
// X-GatherThread-Client-IP and SET one validated address from its actual connection.
export function registrationClientIp(remote: string, header: string | string[] | undefined, trustedProxy?: string): string {
  if (trustedProxy !== remote) return normalizeRegistrationIp(remote);
  if (typeof header !== "string" || !isIP(header)) return "trusted-proxy-unknown";
  return normalizeRegistrationIp(header);
}

export function normalizeRegistrationIp(value: string): string {
  if (isIP(value) !== 6) return value;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split("::");
  const a = left ? left.split(":") : [];
  const b = right ? right.split(":") : [];
  const words = right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
  if (words.slice(0, 5).every((word) => parseInt(word, 16) === 0) && parseInt(words[5]!, 16) === 65535) {
    const high = parseInt(words[6]!, 16), low = parseInt(words[7]!, 16);
    return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  }
  return `${words.slice(0, 4).map((word) => parseInt(word, 16).toString(16)).join(":")}::/64`;
}
