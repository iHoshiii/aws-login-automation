import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:3099", trace: "retain-on-failure" },
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3099",
    url: "http://127.0.0.1:3099/login",
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      APP_URL: "http://127.0.0.1:3099",
      ADMIN_PASSWORD: "e2e-only-password-never-for-deployment",
      DASHBOARD_SESSION_SECRET: "e2e-only-session-secret-never-for-deployment-123456",
      CRON_SECRET: "e2e-only-cron-secret-never-for-deployment-123456789",
      SUPABASE_URL: "",
      SUPABASE_SECRET_KEY: "",
      NOTIFICATION_WEBHOOK_URL: "",
      NOTIFICATION_WEBHOOK_SECRET: ""
    }
  }
});
