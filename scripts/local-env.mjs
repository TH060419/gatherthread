import { randomBytes as secureRandomBytes } from "node:crypto";
import { chmod, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const PEPPER_NAME = "GATHERTHREAD_AUTH_TOKEN_PEPPER";
const PEPPER_LINE = /^GATHERTHREAD_AUTH_TOKEN_PEPPER=(.*)$/m;

export async function ensureLocalOwnerHostEnvironment({
  cwd = process.cwd(),
  env = process.env,
  randomBytes = secureRandomBytes,
} = {}) {
  if (env[PEPPER_NAME]?.trim()) {
    return { generated: false, source: "environment" };
  }

  const envPath = resolve(cwd, ".env");
  let contents;
  let exists = true;
  try {
    const info = await lstat(envPath);
    if (!info.isFile()) throw new Error(".env must be a regular file");
    contents = await readFile(envPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    exists = false;
    contents = await readFile(resolve(cwd, ".env.example"), "utf8");
  }

  const configured = contents.match(PEPPER_LINE)?.[1]?.trim();
  if (configured) {
    env[PEPPER_NAME] = unquote(configured);
    await chmod(envPath, 0o600);
    return { generated: false, source: "file", path: envPath };
  }

  const pepper = randomBytes(32).toString("hex");
  const nextContents = PEPPER_LINE.test(contents)
    ? contents.replace(PEPPER_LINE, `${PEPPER_NAME}=${pepper}`)
    : `${contents.replace(/\s*$/, "")}\n${PEPPER_NAME}=${pepper}\n`;

  await writePrivateEnvironment(envPath, nextContents, exists, randomBytes);
  env[PEPPER_NAME] = pepper;
  return { generated: true, source: "generated", path: envPath };
}

function unquote(value) {
  if (value.length >= 2 && value[0] === value.at(-1) && new Set(["\"", "'"]).has(value[0])) {
    return value.slice(1, -1);
  }
  return value;
}

async function writePrivateEnvironment(envPath, contents, exists, randomBytes) {
  if (!exists) {
    await writeFile(envPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return;
  }

  const temporaryPath = join(
    dirname(envPath),
    `.env.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, envPath);
    await chmod(envPath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
