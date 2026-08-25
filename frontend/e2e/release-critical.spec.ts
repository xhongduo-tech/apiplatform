import { expect, test } from "@playwright/test";

const ADMIN_PASSWORD = "E2e-Admin-Password-2026!";
const BOOTSTRAP_TOKEN = "e2e-bootstrap-token-release-check-2026";

test("first claim, branding, key lifecycle, streaming gateway and logout", async ({ page }) => {
  await page.goto("/admin.html");

  const newPasswordInputs = page.locator('input[autocomplete="new-password"]');
  await expect(newPasswordInputs).toHaveCount(2);
  await newPasswordInputs.nth(0).fill(ADMIN_PASSWORD);
  await page.locator('input[autocomplete="off"]').fill(BOOTSTRAP_TOKEN);
  await newPasswordInputs.nth(1).fill(ADMIN_PASSWORD);

  const loginResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/admin/login") && response.request().method() === "POST",
  );
  await page.locator("form button[type=submit]").click();
  expect((await loginResponse).status()).toBe(200);
  await expect(page.locator("aside")).toBeVisible();

  const initialized = await page.request.get("/api/admin/login/status");
  await expect(initialized).toBeOK();
  expect((await initialized.json()).initialized).toBe(true);

  const maliciousBranding = await page.request.put("/api/admin/branding-config", {
    data: {
      brand_name: "<img src=x onerror=alert(1)>",
      platform_name: "Test Platform",
      browser_title: "Test Platform",
      hero_title: "Test Platform",
      slogan: "Safe gateway",
      organization_name: "Example Organization",
      footer_text: "Example Organization",
      support_department: "Support",
      support_contact: "Maintainer",
      support_email: "support@example.com",
      approval_department: "Operations",
      approval_contact: "Maintainer",
      approval_email: "approval@example.com",
    },
  });
  expect(maliciousBranding.status()).toBe(422);

  const branding = await page.request.put("/api/admin/branding-config", {
    data: {
      brand_name: "E2E Gateway",
      platform_name: "Test Platform",
      browser_title: "E2E Gateway",
      hero_title: "Build safely",
      slogan: "Safe gateway",
      organization_name: "Example Organization",
      footer_text: "Example Organization",
      support_department: "Support",
      support_contact: "Maintainer",
      support_email: "support@example.com",
      approval_department: "Operations",
      approval_contact: "Maintainer",
      approval_email: "approval@example.com",
    },
  });
  await expect(branding).toBeOK();
  const publicConfig = await page.request.get("/api/public/config");
  await expect(publicConfig).toBeOK();
  expect((await publicConfig.json()).brand).toBe("E2E Gateway");

  const modelId = "e2e-chat-model";
  const model = await page.request.put(`/api/admin/models/${modelId}`, {
    data: {
      id: modelId,
      name: "E2E Chat Model",
      provider: "E2E",
      status: "online",
      category: "chat",
      base_url: "http://mock-upstream:9000/v1",
      model_api_name: "mock-chat-model",
      import_format: "openai",
    },
  });
  await expect(model).toBeOK();

  const keyResponse = await page.request.post("/api/admin/keys", {
    data: {
      name: "E2E scenario",
      auth_id: "e2e-user",
      project_name: "E2E project",
      department: "Example team",
      project_desc: "Fictional browser test data",
      scene_type: "explore",
      models: [modelId],
    },
  });
  await expect(keyResponse).toBeOK();
  const createdKey = await keyResponse.json();
  expect(createdKey.api_key).toMatch(/^sk-platform-/);

  const stream = await page.request.post("/v1/chat/completions", {
    headers: { Authorization: `Bearer ${createdKey.api_key}` },
    data: {
      model: modelId,
      messages: [{ role: "user", content: "Return a fictional greeting" }],
      stream: true,
    },
  });
  await expect(stream).toBeOK();
  const streamBody = await stream.text();
  expect(streamBody).toContain("hello from the mock upstream");
  expect(streamBody).toContain("[DONE]");

  const revoke = await page.request.post(`/api/admin/keys/${createdKey.id}/revoke`);
  await expect(revoke).toBeOK();
  const rejected = await page.request.post("/v1/chat/completions", {
    headers: { Authorization: `Bearer ${createdKey.api_key}` },
    data: { model: modelId, messages: [{ role: "user", content: "must fail" }] },
  });
  expect(rejected.status()).toBe(401);

  await expect(await page.request.post("/api/admin/logout")).toBeOK();
  expect((await page.request.get("/api/admin/session")).status()).toBe(401);
});

test("production surface keeps dynamic API documentation private", async ({ page }) => {
  const home = await page.goto("/");
  expect(home?.status()).toBe(200);
  await expect(page.locator("body")).toBeVisible();

  for (const path of ["/docs", "/redoc", "/openapi.json"]) {
    const response = await page.request.get(path);
    expect(response.headers()["content-type"]).not.toContain("application/json");
    expect(await response.text()).not.toContain("Swagger UI");
  }
});
