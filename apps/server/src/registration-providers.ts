import { isIP } from "node:net";
import { z } from "zod";
import { RegistrationEmailSchema } from "@gatherthread/protocol";
import type { RegistrationChallenge, RegistrationMailer, RegistrationOptions } from "./registration.js";

const ChallengeResult = z.object({ success: z.boolean(), hostname: z.string().optional(), action: z.string().optional(), cdata: z.string().optional() });
/** Provider responses/errors never enter logs or API replies. No redirect or unbounded retry. */
export class TurnstileRegistrationChallenge implements RegistrationChallenge {
  constructor(private readonly secret: string, private readonly hostname: string, private readonly transport: typeof fetch = fetch) {}
  async verify(token: string, binding: string): Promise<boolean> {
    const response = await this.transport("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
      body: new URLSearchParams({ secret: this.secret, response: token }),
    });
    if (!response.ok) return false;
    const value = ChallengeResult.safeParse(await response.json());
    return value.success && value.data.success && value.data.hostname === this.hostname
      && value.data.action === "gt_register" && value.data.cdata === binding;
  }
}
export class ResendRegistrationMailer implements RegistrationMailer {
  constructor(private readonly key: string, private readonly from: string, private readonly transport: typeof fetch = fetch) {}
  async send(message: Parameters<RegistrationMailer["send"]>[0]): Promise<void> {
    const zh = message.locale === "zh-CN";
    const response = await this.transport("https://api.resend.com/emails", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json", "idempotency-key": `registration-${message.deliveryId}` },
      body: JSON.stringify({ from: this.from, to: [message.email], subject: zh ? "GatherThread 注册验证码" : "GatherThread registration code",
        text: zh ? `您的注册验证码：${message.code}\n10 分钟内有效，请在请求验证码的浏览器填写。不要向他人分享。\n若您未请求注册，请忽略此邮件。此验证码不能登录或恢复已有账号。`
          : `Your registration code: ${message.code}\nValid for 10 minutes in the browser that requested it. Do not share it.\nIf you did not request registration, ignore this email. This code cannot sign in to or recover an existing account.` }),
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
  const proxy = env.GATHERTHREAD_REGISTRATION_TRUSTED_PROXY;
  if (proxy && !isIP(proxy)) throw new Error("Registration trusted proxy must be one exact IP address");
  const closed = (): RegistrationOptions => ({ enabled: false, ...(proxy ? { trustedProxy: proxy } : {}) });
  if (raw !== "true") return closed();
  const siteKey = env.GATHERTHREAD_TURNSTILE_SITE_KEY;
  const secret = env.GATHERTHREAD_TURNSTILE_SECRET;
  const key = env.GATHERTHREAD_REGISTRATION_RESEND_KEY;
  const from = RegistrationEmailSchema.safeParse(env.GATHERTHREAD_REGISTRATION_FROM);
  // Missing dependencies close only registration; existing Alpha sign-in still works.
  const origin = new URL(publicOrigin);
  if (origin.protocol !== "https:" || !siteKey || !secret || !key || !from.success) return closed();
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(siteKey) || secret.length < 20 || key.length < 20) return closed();
  return { enabled: true, origin: origin.origin, siteKey,
    mailer: new ResendRegistrationMailer(key, from.data),
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
