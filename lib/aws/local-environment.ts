import { existsSync, readFileSync } from "node:fs";

/** Local CLI configuration only; production reads its server environment. */
export function loadLocalAwsEnvironment(includeSession = false) {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  if (!process.env.AWS_BUILDER_ID_EMAIL?.trim() && existsSync(".local/aws-account.env")) {
    const content = readFileSync(".local/aws-account.env", "utf8").replace(/^\uFEFF/, "");
    const match = /^AWS_BUILDER_ID_EMAIL=([^\r\n]+)$/m.exec(content);
    if (match) process.env.AWS_BUILDER_ID_EMAIL = match[1].trim();
  }
  if (includeSession && existsSync(".local/aws-session.env")) process.loadEnvFile(".local/aws-session.env");
}
