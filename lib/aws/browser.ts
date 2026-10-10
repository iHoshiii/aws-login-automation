import { chromium as playwright, type Browser, type BrowserContext } from "playwright-core";
import type { AwsSessionBundle } from "./session";

export async function launchAwsBrowser(options: { headless?: boolean; session?: AwsSessionBundle } = {}): Promise<{ browser: Browser; context: BrowserContext }> {
  const serverless = process.env.VERCEL === "1";
  let browser: Browser;
  if (serverless) {
    if (process.platform !== "linux" || process.arch !== "x64") throw new Error("The packaged serverless browser requires Linux x64.");
    const { default: chromium } = await import("@sparticuz/chromium");
    browser = await playwright.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true, timeout: 20000 });
  } else {
    browser = await playwright.launch({ ...(process.env.AWS_LOCAL_CHROMIUM_PATH ? { executablePath: process.env.AWS_LOCAL_CHROMIUM_PATH } : {}), headless: options.headless ?? true, timeout: 20000 });
  }
  try {
    const context = await browser.newContext({ storageState: options.session?.storageState, viewport: { width: 1365, height: 900 }, locale: "en-US" });
    context.setDefaultTimeout(8000);
    context.setDefaultNavigationTimeout(18000);
    return { browser, context };
  } catch (error) { await browser.close(); throw error; }
}
