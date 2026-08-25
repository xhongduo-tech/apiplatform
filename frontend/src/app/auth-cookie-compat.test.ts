import { describe, expect, it, vi } from "vitest";

import { ADMIN_EXPIRED_EVENT, COOKIE_SESSION_TOKEN } from "./api/gateway";
import { authHeaders, requireOk } from "./components/admin-tab-utils";

describe("HttpOnly admin cookie compatibility", () => {
  it("never serializes the cookie-session sentinel as a Bearer credential", () => {
    expect(authHeaders(COOKIE_SESSION_TOKEN)).toEqual({
      "Content-Type": "application/json",
    });
    expect(authHeaders("real-api-token")).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer real-api-token",
    });
  });

  it("turns a step-up 401 into the shared reauthentication event", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    const response = new Response(JSON.stringify({ detail: "请重新验证管理员密码" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });

    await expect(requireOk(response, "failed")).rejects.toThrow("请重新验证管理员密码");
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: ADMIN_EXPIRED_EVENT }));
    vi.unstubAllGlobals();
  });
});
