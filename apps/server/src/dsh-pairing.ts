import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Actor, CollaborationDatabase, DeviceRecord } from "./database.js";
import { ApiError, conflict, unauthorized } from "./errors.js";

export const DSH_PAIRING_TTL_MS = 5 * 60_000;
export const DSH_PAIRING_POLL_INTERVAL_SECONDS = 2;
export const DSH_PAIRING_MAX_PENDING = 1_024;

const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const POLL_TOKEN_PREFIX = "gtp_";

interface PendingDshPairing {
  readonly id: string;
  readonly userCode: string;
  readonly pollTokenDigest: Buffer;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  approvedBy?: Actor;
  consuming: boolean;
}

export interface DshPairingIntent {
  readonly pairing_id: string;
  readonly poll_token: string;
  readonly user_code: string;
  readonly verification_path: string;
  readonly expires_at: string;
  readonly interval_seconds: number;
}

export interface DshPairingApproval {
  readonly pairing_id: string;
  readonly user_code: string;
  readonly device_name: string;
  readonly expires_at: string;
  readonly status: "approved";
}

export type DshPairingPollResult =
  | {
    readonly status: "pending";
    readonly expires_at: string;
    readonly interval_seconds: number;
  }
  | {
    readonly status: "paired";
    readonly device_id: string;
    readonly token: string;
  };

interface DshPairingBrokerOptions {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
  readonly randomId?: () => string;
  readonly ttlMs?: number;
  readonly maxPending?: number;
}

/**
 * Short-lived, process-local device authorization rendezvous.
 *
 * The browser never receives the long-lived credential. Pending intents are
 * deliberately not durable: a server restart invalidates them and the user
 * starts a fresh pairing instead of leaving a reusable grant on disk.
 */
export class DshDevicePairingBroker {
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #randomId: () => string;
  readonly #ttlMs: number;
  readonly #maxPending: number;
  readonly #byId = new Map<string, PendingDshPairing>();
  readonly #idByUserCode = new Map<string, string>();

  constructor(options: DshPairingBrokerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? randomBytes;
    this.#randomId = options.randomId ?? randomUUID;
    this.#ttlMs = options.ttlMs ?? DSH_PAIRING_TTL_MS;
    this.#maxPending = options.maxPending ?? DSH_PAIRING_MAX_PENDING;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1_000) {
      throw new TypeError("DSH pairing TTL must be at least one second");
    }
    if (!Number.isSafeInteger(this.#maxPending) || this.#maxPending < 1) {
      throw new TypeError("DSH pairing capacity must be a positive safe integer");
    }
  }

  begin(deviceName: string): DshPairingIntent {
    const now = this.#now();
    this.#prune(now);
    if (this.#byId.size >= this.#maxPending) {
      throw new ApiError(503, "pairing_capacity_exceeded", "Too many DSH pairings are pending");
    }
    const id = `dshp_${this.#randomId()}`;
    const deviceId = `dsh_${this.#randomId()}`;
    const pollToken = `${POLL_TOKEN_PREFIX}${this.#randomBytes(32).toString("base64url")}`;
    const userCode = this.#uniqueUserCode();
    const expiresAtMs = now + this.#ttlMs;
    this.#byId.set(id, {
      id,
      userCode,
      pollTokenDigest: digest(pollToken),
      deviceId,
      deviceName,
      createdAtMs: now,
      expiresAtMs,
      consuming: false,
    });
    this.#idByUserCode.set(userCode, id);
    return {
      pairing_id: id,
      poll_token: pollToken,
      user_code: userCode,
      verification_path: `/#dsh-pair=${encodeURIComponent(userCode)}`,
      expires_at: new Date(expiresAtMs).toISOString(),
      interval_seconds: DSH_PAIRING_POLL_INTERVAL_SECONDS,
    };
  }

  approve(actor: Actor, userCode: string): DshPairingApproval {
    const now = this.#now();
    this.#prune(now);
    const pairing = this.#pairingForUserCode(userCode);
    if (pairing.approvedBy !== undefined) {
      if (pairing.approvedBy.user_id !== actor.user_id) {
        throw conflict("This DSH pairing was approved by another account");
      }
    } else {
      pairing.approvedBy = { ...actor };
    }
    return {
      pairing_id: pairing.id,
      user_code: pairing.userCode,
      device_name: pairing.deviceName,
      expires_at: new Date(pairing.expiresAtMs).toISOString(),
      status: "approved",
    };
  }

  poll(
    pairingId: string,
    pollToken: string,
    issueDevice: (
      userId: string,
      deviceName: string,
      deviceId: string,
    ) => { device_id: string; token: string; device: DeviceRecord },
  ): DshPairingPollResult {
    const now = this.#now();
    this.#prune(now);
    const pairing = this.#byId.get(pairingId);
    if (pairing === undefined || !validPollToken(pollToken, pairing.pollTokenDigest)) {
      throw unauthorized("DSH pairing is invalid, expired, or already consumed");
    }
    if (pairing.consuming) {
      throw unauthorized("DSH pairing is invalid, expired, or already consumed");
    }
    if (pairing.approvedBy === undefined) {
      return {
        status: "pending",
        expires_at: new Date(pairing.expiresAtMs).toISOString(),
        interval_seconds: DSH_PAIRING_POLL_INTERVAL_SECONDS,
      };
    }

    pairing.consuming = true;
    try {
      const issued = issueDevice(
        pairing.approvedBy.user_id,
        pairing.deviceName,
        pairing.deviceId,
      );
      this.#delete(pairing);
      return {
        status: "paired",
        device_id: issued.device_id,
        token: issued.token,
      };
    } catch (error) {
      pairing.consuming = false;
      throw error;
    }
  }

  clear(): void {
    this.#byId.clear();
    this.#idByUserCode.clear();
  }

  get pendingCount(): number {
    this.#prune(this.#now());
    return this.#byId.size;
  }

  #uniqueUserCode(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const entropy = this.#randomBytes(8);
      let raw = "";
      for (let index = 0; index < 8; index += 1) {
        raw += USER_CODE_ALPHABET[Number(entropy[index]) % USER_CODE_ALPHABET.length];
      }
      const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      if (!this.#idByUserCode.has(code)) return code;
    }
    throw new ApiError(503, "pairing_capacity_exceeded", "Unable to allocate a DSH pairing code");
  }

  #pairingForUserCode(userCode: string): PendingDshPairing {
    const id = this.#idByUserCode.get(userCode);
    const pairing = id === undefined ? undefined : this.#byId.get(id);
    if (pairing === undefined || pairing.consuming) {
      throw new ApiError(404, "pairing_unavailable", "DSH pairing is invalid, expired, or already consumed");
    }
    return pairing;
  }

  #prune(now: number): void {
    for (const pairing of this.#byId.values()) {
      if (pairing.expiresAtMs <= now) this.#delete(pairing);
    }
  }

  #delete(pairing: PendingDshPairing): void {
    this.#byId.delete(pairing.id);
    this.#idByUserCode.delete(pairing.userCode);
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function validPollToken(value: string, expectedDigest: Buffer): boolean {
  if (!value.startsWith(POLL_TOKEN_PREFIX) || value.length > 128) return false;
  const actual = digest(value);
  return actual.length === expectedDigest.length && timingSafeEqual(actual, expectedDigest);
}

export function dshPairingPollToken(authorization: string | undefined): string {
  const match = /^DSH-Pairing ([A-Za-z0-9_-]{40,128})$/u.exec(authorization ?? "");
  if (match?.[1] === undefined) {
    throw unauthorized("A valid DSH pairing poll credential is required");
  }
  return match[1];
}
