import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { installControlPicker } from "@/lib/aws/control-picker";

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
});
