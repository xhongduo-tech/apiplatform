import { describe, expect, it } from "vitest";
import { nextMenuItemIndex } from "./accessibility";
import { isPlatformStorageKey } from "./components/AppErrorBoundary";
import { requireOk } from "./components/admin-tab-utils";
import { chooseActiveSection } from "./components/docs/active-section";
import { shouldPrefetch } from "./lazy-retry";

describe("mobile menu keyboard navigation", () => {
  it("wraps arrow navigation and supports Home/End", () => {
    expect(nextMenuItemIndex("ArrowDown", 2, 3)).toBe(0);
    expect(nextMenuItemIndex("ArrowUp", 0, 3)).toBe(2);
    expect(nextMenuItemIndex("ArrowDown", -1, 3)).toBe(0);
    expect(nextMenuItemIndex("Home", 2, 3)).toBe(0);
    expect(nextMenuItemIndex("End", 0, 3)).toBe(2);
    expect(nextMenuItemIndex("Tab", 1, 3)).toBeNull();
  });
});

describe("admin mutation response guard", () => {
  it("rejects non-2xx JSON responses before optimistic UI updates", async () => {
    const response = new Response(JSON.stringify({ detail: "operation denied" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
    await expect(requireOk(response, "failed")).rejects.toThrow("operation denied");
  });

  it("passes successful responses through", async () => {
    const response = new Response(null, { status: 204 });
    await expect(requireOk(response, "failed")).resolves.toBe(response);
  });
});

describe("error-boundary storage cleanup scope", () => {
  it("includes user/session keys while preserving theme and unrelated data", () => {
    expect(isPlatformStorageKey("platform_user")).toBe(true);
    expect(isPlatformStorageKey("apiplatform-models-cache")).toBe(true);
    expect(isPlatformStorageKey("apiplatform-theme")).toBe(false);
    expect(isPlatformStorageKey("another-application")).toBe(false);
  });
});

describe("legacy docs scroll spy", () => {
  it("uses the last heading above the sticky-header offset", () => {
    expect(chooseActiveSection([
      { id: "intro", top: -180 },
      { id: "auth", top: 60 },
      { id: "errors", top: 320 },
    ])).toBe("auth");
    expect(chooseActiveSection([{ id: "intro", top: 160 }])).toBe("intro");
  });
});

describe("idle prefetch budget", () => {
  it("does not prefetch for save-data, slow links, or hidden tabs", () => {
    expect(shouldPrefetch({ saveData: true }, false)).toBe(false);
    expect(shouldPrefetch({ effectiveType: "3g" }, false)).toBe(false);
    expect(shouldPrefetch({ effectiveType: "4g" }, false)).toBe(true);
    expect(shouldPrefetch(undefined, true)).toBe(false);
  });
});
