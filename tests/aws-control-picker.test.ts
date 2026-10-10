import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { installControlPicker } from "@/lib/aws/control-picker";

const runNode = promisify(execFile);

describe("local AWS connection control selection", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterEach(async () => { await page?.close(); });
  afterAll(async () => { await browser?.close(); });

  it.each([false, true])("records a submit control without activating it (disabled=%s)", async disabled => {
    page = await browser.newPage();
    await page.setContent(`<button id="submit" ${disabled ? "disabled" : ""} onclick="window.submissions++">Post comment</button><script>window.submissions=0</script>`);
    let captured: { selector: string; href: string | null } | undefined;
    await page.exposeFunction("recordAwsControl", (value: typeof captured) => { captured = value; });
    await installControlPicker(page, "Choose submit", "button");
    const bounds = await page.locator("#submit").boundingBox();
    if (!bounds) throw new Error("Fixture button is not visible.");
    // Mouse input permits selection of a disabled button, unlike Locator.click.
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await vi.waitFor(() => expect(captured).toEqual({ selector: "#submit", href: null }));
    expect(await page.evaluate(() => (window as unknown as { submissions: number }).submissions)).toBe(0);
  });

  it("blocks an unrelated control while waiting for the requested editor", async () => {
    page = await browser.newPage();
    await page.setContent('<button id="danger" onclick="window.submissions++">Post comment</button><textarea id="editor"></textarea><script>window.submissions=0</script>');
    let captured: { selector: string; href: string | null } | undefined;
    await page.exposeFunction("recordAwsControl", (value: typeof captured) => { captured = value; });
    await installControlPicker(page, "Choose editor", "editor");
    await page.locator("#danger").click();
    expect(captured).toBeUndefined();
    expect(await page.evaluate(() => (window as unknown as { submissions: number }).submissions)).toBe(0);
    await page.locator("#editor").click();
    await vi.waitFor(() => expect(captured?.selector).toBe("#editor"));
  });

  it("runs through the real tsx loader without browser helpers or publishing either submit control", async () => {
    const pickerUrl = new URL("../lib/aws/control-picker.ts", import.meta.url).href;
    const { stdout } = await runNode(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { chromium } from "playwright-core";
      import { installControlPicker } from ${JSON.stringify(pickerUrl)};
      const browser = await chromium.launch({ headless: true });
      try {
        for (const disabled of [false, true]) {
          const page = await browser.newPage();
          try {
            await page.setContent('<button id="submit" ' + (disabled ? 'disabled' : '') + ' onclick="window.submissions++">Post comment</button><script>window.submissions=0</script>');
            assert.equal(await page.evaluate(() => typeof globalThis.__name), "undefined");
            let record;
            const captured = new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error("Control was not recorded.")), 5000);
              record = value => { clearTimeout(timer); resolve(value); };
            });
            await page.exposeFunction("recordAwsControl", record);
            await installControlPicker({
              evaluate(callback, argument) {
                assert.equal(callback.toString().includes("__name"), false);
                return page.evaluate(callback, argument);
              }
            }, "Choose submit", "button");
            const bounds = await page.locator("#submit").boundingBox();
            assert.ok(bounds);
            await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            assert.deepEqual(await captured, { selector: "#submit", href: null });
            assert.equal(await page.evaluate(() => window.submissions), 0);
            assert.equal(await page.evaluate(() => typeof globalThis.__name), "undefined");
          } finally { await page.close(); }
        }
        process.stdout.write("picker-tsx-regression-ok");
      } finally { await browser.close(); }
    `], { cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 20000 });
    expect(stdout).toBe("picker-tsx-regression-ok");
  });
});
