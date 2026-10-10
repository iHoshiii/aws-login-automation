import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright-core";

interface ManualChrome {
  executable: string;
  profile: string;
  process: ChildProcess;
}

function chromeExecutable(): string {
  const candidates = process.env.AWS_MANUAL_CHROME_PATH ? [process.env.AWS_MANUAL_CHROME_PATH] : process.platform === "win32" ? [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google/Chrome/Application/chrome.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe")
  ] : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error("Install Google Chrome or configure AWS_MANUAL_CHROME_PATH before using manual-browser connection.");
  return found;
}

async function start(executable: string, args: string[]): Promise<ChildProcess> {
  const child = spawn(executable, args, { shell: false, stdio: "ignore", windowsHide: false });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () => reject(new Error("Could not open the dedicated AWS Chrome window.")));
  });
  return child;
}

export async function waitForManualChromeClosed(child: ChildProcess, timeoutMs = 30000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", closed);
      reject(new Error("Close the dedicated AWS Chrome window after completing sign-in, then reconnect. Your other Chrome windows can stay open."));
    }, timeoutMs);
    function closed() { clearTimeout(timer); resolve(); }
    child.once("exit", closed);
  });
}

/** Human login phase: normal Chrome, isolated profile, no automation transport. */
export async function openManualChrome(): Promise<ManualChrome> {
  if (process.env.VERCEL === "1") throw new Error("Manual browser connection runs on your own computer.");
  const executable = chromeExecutable();
  const profile = resolve(".local/aws-manual-profile");
  await mkdir(profile, { recursive: true });
  const child = await start(executable, [
    `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-background-mode", "https://builder.aws.com/"
  ]);
  return { executable, profile, process: child };
}

/** Attach only after the owner completes login and closes their dedicated window. */
export async function attachManualChrome(login: ManualChrome): Promise<{ browser: Browser; context: BrowserContext; close: () => Promise<void> }> {
  await waitForManualChromeClosed(login.process);
  const portFile = join(login.profile, "DevToolsActivePort");
  // Remove this one stale handshake file; never alter Chrome's profile locks.
  await rm(portFile, { force: true });
  const child = await start(login.executable, [
    `--user-data-dir=${login.profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-mode",
    "--restore-last-session", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "https://builder.aws.com/"
  ]);
  let browser: Browser | undefined;
  try {
    const deadline = Date.now() + 30000;
    let endpoint: string | undefined;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("The dedicated Chrome profile is still in use or could not be reopened. Close its windows and reconnect.");
      try {
        const value = await readFile(portFile, "utf8");
        const [portText, browserPath] = value.trim().split(/\r?\n/);
        const port = Number(portText);
        if (!/^\d{1,5}$/.test(portText) || !Number.isInteger(port) || port < 1024 || port > 65535 || !/^\/devtools\/browser\/[a-f0-9-]+$/i.test(browserPath ?? "")) {
          throw new Error("invalid_port");
        }
        endpoint = `http://127.0.0.1:${port}`;
        break;
      } catch (error) {
        if (error instanceof Error && error.message === "invalid_port") throw new Error("Chrome returned an invalid local connection endpoint.", { cause: error });
      }
      await new Promise<void>(resolve => setTimeout(resolve, 200));
    }
    if (!endpoint) throw new Error("Chrome's local connection did not become ready. Close the dedicated window and reconnect.");
    browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error("The dedicated Chrome profile could not be opened.");
    context.setDefaultTimeout(8000);
    context.setDefaultNavigationTimeout(18000);
    const connected = browser;
    return { browser, context, close: async () => {
      try { const control = await connected.newBrowserCDPSession(); await control.send("Browser.close"); } catch { /* Chrome may close its connection before acknowledging. */ }
      try { await connected.close(); } catch { /* Already closed. */ }
      try { await waitForManualChromeClosed(child, 5000); } catch { child.kill(); }
    } };
  } catch (error) {
    try { await browser?.close(); } catch { /* Preserve generic diagnostic. */ }
    child.kill();
    throw error;
  }
}
