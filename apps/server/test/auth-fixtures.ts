import { randomUUID } from "node:crypto";
import type { CollaborationDatabase } from "../src/database.js";
import type { CollaborationService } from "../src/service.js";

type Server = { database: CollaborationDatabase; service: CollaborationService };
type Options = { method?: string; token?: string; origin?: string; headers?: Record<string, string>; body?: {
  user_id?: string; display_name?: string; device_id?: string; device_name?: string;
  invite_token?: string; remember_device?: boolean;
} };

// Database setup for native-device API and Cookie authorization tests. Public email
// registration/login and cookie issuance are exercised separately in registration.test.
export function identityFixture(server: Server, { body = {} }: Options) {
  const identity = server.database.createIdentity({ display_name: body.display_name ?? "Fixture user",
    device_name: body.device_name ?? "Fixture device", user_id: body.user_id,
    device_id: body.device_id, can_create_projects: true });
  server.database.sqlite.prepare(`INSERT INTO public_registration_accounts
    (user_id,email_digest,password_hash,verified_at) VALUES(?,?,?,?)`)
    .run(identity.actor.user_id, randomUUID(), "authorization-fixture-only", Date.now());
  return { status: 201, body: { data: identity }, headers: new Headers() };
}

export function invitationFixture(server: Server, options: Options) {
  const identity = identityFixture(server, options);
  server.service.claimInvitationForActor(identity.body.data.actor, options.body!.invite_token!);
  const session = browserSessionFixture(server, { token: identity.body.data.token });
  return { ...identity, headers: session.headers };
}

export function browserSessionFixture(server: Server, options: Options) {
  const actor = server.database.authenticate(options.token!);
  if (!server.database.registration.hasAccount(actor.user_id)) {
    server.database.sqlite.prepare(`INSERT INTO public_registration_accounts
      (user_id,email_digest,password_hash,verified_at) VALUES(?,?,?,?)`)
      .run(actor.user_id, randomUUID(), "authorization-fixture-only", Date.now());
  }
  const issue = server.database.createBrowserSession(actor, options.body?.remember_device);
  const secure = options.origin?.startsWith("https:") === true;
  const cookie = `${secure ? "__Host-" : ""}gatherthread_session=${issue.token}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}${options.body?.remember_device ? `; Max-Age=2592000; Expires=${new Date(issue.expires_at).toUTCString()}` : ""}`;
  const headers = new Headers({ "set-cookie": cookie, "access-control-allow-credentials": "true" });
  return { status: 201, body: { data: { actor: { id: actor.user_id }, expires_at: issue.expires_at } }, headers };
}
