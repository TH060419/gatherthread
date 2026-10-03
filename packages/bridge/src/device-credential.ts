// Connector-only exchange: the browser gets a ten-minute one-use grant, never
// the resulting long-lived device credential. No retry after ambiguous delivery.
export async function resolveDeviceCredential(input: string, apiUrl: string, transport: typeof fetch = fetch): Promise<string> {
  if (!input || /[\r\n]/u.test(input)) throw new Error("A device authorization is required");
  // Existing private connector credentials remain usable; they are not user login.
  if (!input.startsWith("gtd_")) {
    if (!/^gta_[A-Za-z0-9_-]{1,508}$/u.test(input)) throw new Error("Use a one-time device authorization, never your password");
    return input;
  }
  if (!/^gtd_[A-Za-z0-9_-]{43}$/u.test(input)) throw new Error("Invalid device authorization");
  try {
    const response = await transport(`${apiUrl.replace(/\/$/u, "")}/device-authorizations/claim`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authorization_token: input, device_name: "Codex connector" }),
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(); }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 16_384) { await reader.cancel(); throw new Error(); }
      chunks.push(chunk.value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8")).data;
    if (!/^gta_[A-Za-z0-9_-]{43}$/u.test(data?.token ?? "")) throw new Error();
    return data.token as string;
  } catch { throw new Error("Device authorization failed. Create a new one in the signed-in Web app."); }
}
