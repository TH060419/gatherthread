import { DSH_STATUS_PATH, type DshPublicStatusSnapshot } from "./status.js";

/** Credential-free state rendered by the pinned DSH Web Client Slot. */
export type GatherThreadDshClientSlotState = DshPublicStatusSnapshot;

export const DSH_CLIENT_SLOT_MVP = Object.freeze({
  implemented: true,
  receivesCredentials: false,
  mutatesCanonicalHistory: false,
  statusPath: DSH_STATUS_PATH,
  transport: "dsh-authenticated-same-origin-fetch",
});
