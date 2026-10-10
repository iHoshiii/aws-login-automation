import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn(), mkdir: vi.fn(), read: vi.fn(), rm: vi.fn(), connect: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", () => ({ existsSync: mocks.exists }));
vi.mock("node:fs/promises", () => ({ mkdir: mocks.mkdir, readFile: mocks.read, rm: mocks.rm }));
vi.mock("playwright-core", () => ({ chromium: { connectOverCDP: mocks.connect } }));
import { attachManualChrome, openManualChrome, waitForManualChromeClosed } from "@/lib/aws/manual-browser";

describe("manual Chrome authentication and later AWS capture", () => {
  const children: ChildProcess[] = [];
  const timeout = vi.fn();
  const navigationTimeout = vi.fn();
  function exit(child: ChildProcess) { Object.defineProperty(child, "exitCode", { value: 0, writable: true, configurable: true }); child.emit("exit", 0, null); }
  beforeEach(() => {
    vi.resetAllMocks();
    children.length = 0;
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("AWS_MANUAL_CHROME_PATH", "C:/fixture/chrome.exe");
    mocks.exists.mockReturnValue(true);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.rm.mockResolvedValue(undefined);
    mocks.read.mockResolvedValue("32456\r\n/devtools/browser/12345678-1234-1234-1234-123456789abc\r\n");
    mocks.spawn.mockImplementation(() => {
      const emitter = new EventEmitter() as ChildProcess;
      Object.defineProperties(emitter, {
        exitCode: { value: null, writable: true, configurable: true },
        signalCode: { value: null, writable: true, configurable: true }
      });
      emitter.kill = vi.fn(() => { exit(emitter); return true; });
      children.push(emitter);
      queueMicrotask(() => emitter.emit("spawn"));
      return emitter;
    });
    mocks.connect.mockResolvedValue({
      contexts: () => [{ setDefaultTimeout: timeout, setDefaultNavigationTimeout: navigationTimeout }],
      newBrowserCDPSession: async () => ({ send: async () => { exit(children.at(-1)!); } }),
      close: vi.fn().mockResolvedValue(undefined)
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("opens human sign-in without an automation connection or the default Chrome profile", async () => {
    const login = await openManualChrome();
    const args: string[] = mocks.spawn.mock.calls[0][1];
    expect(args).toContain(`--user-data-dir=${login.profile}`);
    expect(login.profile.replaceAll("\\", "/")).toMatch(/\/.local\/aws-manual-profile$/);
    expect(args).toContain("https://builder.aws.com/");
    expect(args.some(argument => /debugging|enable-automation|headless/.test(argument))).toBe(false);
    expect(mocks.spawn.mock.calls[0][2].shell).toBe(false);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("waits for the human browser to close before reopening the same profile for local capture", async () => {
    const login = await openManualChrome();
    const attaching = attachManualChrome(login);
    await Promise.resolve();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.connect).not.toHaveBeenCalled();
    exit(login.process);
    const connected = await attaching;
    const args: string[] = mocks.spawn.mock.calls[1][1];
    expect(args).toContain(`--user-data-dir=${login.profile}`);
    expect(args).toContain("--restore-last-session");
    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(mocks.connect).toHaveBeenCalledWith("http://127.0.0.1:32456", { timeout: 10000 });
    expect(mocks.rm).toHaveBeenCalledWith(expect.stringMatching(/DevToolsActivePort$/), { force: true });
    expect(navigationTimeout).toHaveBeenCalledWith(18000);
    await connected.close();
    expect(login.process.kill).not.toHaveBeenCalled();
  });

  it("rejects a malformed local endpoint and stops only its capture process", async () => {
    const login = await openManualChrome();
    exit(login.process);
    mocks.read.mockResolvedValue("80\n/devtools/browser/not-a-real-id");
    await expect(attachManualChrome(login)).rejects.toThrow("invalid local connection endpoint");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(children[1].kill).toHaveBeenCalledTimes(1);
    expect(login.process.kill).not.toHaveBeenCalled();
  });

  it("leaves an unfinished human login open and reports that its dedicated window must close", async () => {
    const login = await openManualChrome();
    vi.useFakeTimers();
    const waiting = waitForManualChromeClosed(login.process, 50);
    const assertion = expect(waiting).rejects.toThrow("Close the dedicated AWS Chrome window");
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
    expect(login.process.kill).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("reports a missing Chrome installation before creating a profile or process", async () => {
    mocks.exists.mockReturnValue(false);
    await expect(openManualChrome()).rejects.toThrow("Install Google Chrome");
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
