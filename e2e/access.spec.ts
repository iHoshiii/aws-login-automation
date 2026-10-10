import { expect, test } from "@playwright/test";

test("a private dashboard redirects to login and rejects the wrong password", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel(/password/i).fill("wrong-password");
  await page.getByRole("button", { name: /open dashboard/i }).click();
  await expect(page.locator("#login-error")).toContainText(/incorrect/i, { timeout: 15000 });
});

test("dashboard login yields an HttpOnly session and an honest missing-storage state", async ({ page, context }) => {
  await page.goto("/login");
  await page.getByLabel(/password/i).fill("e2e-only-password-never-for-deployment");
  await page.getByRole("button", { name: /open dashboard/i }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3099/", { timeout: 15000 });
  await expect(page.getByText(/Supabase/i).first()).toBeVisible();
  expect((await context.cookies()).find(cookie => cookie.name === "builder_daily_session")?.httpOnly).toBe(true);
});

test("cron has an authenticated dry run without database or external actions", async ({ request }) => {
  expect((await request.get("/api/cron")).status()).toBe(401);
  const response = await request.get("/api/cron?dryRun=1", {
    headers: { Authorization: "Bearer e2e-only-cron-secret-never-for-deployment-123456789" }
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ outcome: "dry_run", databaseWritten: false, notificationsSent: false, browserOpened: false, manualOnly: false });
});

test("cross-origin and unauthenticated dashboard mutations fail closed", async ({ request }) => {
  expect((await request.post("/api/run", { data: {}, headers: { Origin: "https://foreign.example" } })).status()).toBe(403);
  expect((await request.post("/api/run", { data: {}, headers: { Origin: "http://127.0.0.1:3099" } })).status()).toBe(401);
});
