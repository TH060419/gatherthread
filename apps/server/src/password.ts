import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// OWASP scrypt baseline: N=2^17, r=8, p=1. No extra dependency or experimental API.
const N = 131072;
let running = false;
export class PasswordCapacityError extends Error {}
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  // Bound expensive work and memory. Do not queue unauthenticated secrets indefinitely.
  if (running) throw new PasswordCapacityError();
  running = true;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 32, { N, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }, (error, value) => error ? reject(error) : resolve(value));
    });
  } finally { running = false; }
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt-v1:${salt.toString("hex")}:${key.toString("hex")}`;
}
export async function checkPassword(password: string, hash: string | undefined): Promise<boolean> {
  const parts = hash?.split(":");
  const valid = parts?.length === 3 && parts[0] === "scrypt-v1" && /^[a-f0-9]{32}$/.test(parts[1]!) && /^[a-f0-9]{64}$/.test(parts[2]!);
  // Unknown addresses do the same expensive work to avoid a timing enumeration oracle.
  const salt = Buffer.from(valid ? parts![1]! : "0".repeat(32), "hex");
  const expected = Buffer.from(valid ? parts![2]! : "0".repeat(64), "hex");
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected) && !!valid;
}
