import { describe, expect, it } from "vitest";
import {
  detectChromiumMajor,
  parseBrowserProfile,
  shouldBlockLegacyEngine,
  shouldReduceEffects,
} from "./compat-utils";

describe("parseBrowserProfile", () => {
  it("detects IE / Trident", () => {
    const p = parseBrowserProfile(
      "Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; rv:11.0) like Gecko",
    );
    expect(p.isIE).toBe(true);
    expect(shouldBlockLegacyEngine(p)).toBe(true);
  });

  it("detects EdgeHTML separately from Chromium Edg", () => {
    const p = parseBrowserProfile(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.18363",
    );
    expect(p.isEdgeHtml).toBe(true);
    expect(p.isIE).toBe(false);
    // EdgeHTML 由 legacy nomodule 包承接，不静态拦截
    expect(shouldBlockLegacyEngine(p)).toBe(false);
  });

  it("parses Chromium Edge from Edg/", () => {
    const p = parseBrowserProfile(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
    );
    expect(p.isEdgeHtml).toBe(false);
    expect(p.chromeMajor).toBe(120);
  });

  it("detects 360 SE domestic shell", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36 QIHU 360SE";
    const p = parseBrowserProfile(ua);
    expect(p.isDomesticShell).toBe(true);
    expect(p.chromeMajor).toBe(86);
    expect(shouldReduceEffects(p)).toBe(true);
  });

  it("detects QQ Browser", () => {
    const p = parseBrowserProfile(
      "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.71 Safari/537.36 Core/1.94.212.400 QQBrowser/11.8.5300.400",
    );
    expect(p.isDomesticShell).toBe(true);
    expect(shouldReduceEffects(p)).toBe(true);
  });

  it.each([
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/86.0.4240.198 Safari/537.36 KylinBrowser/1.0",
    "Mozilla/5.0 (X11; UOS x86_64) AppleWebKit/537.36 Chromium/78.0.3904.108 Safari/537.36 UOSBrowser/6.0",
    "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/86.0.4240.198 Safari/537.36 QAXBrowser/1.2",
    "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/86.0.4240.198 Safari/537.36 360Browser",
  ])("detects domestic Linux/security browser shell: %s", (ua) => {
    const p = parseBrowserProfile(ua);
    expect(p.isDomesticShell).toBe(true);
    expect(shouldReduceEffects(p)).toBe(true);
  });

  it("reduces effects on EdgeHTML", () => {
    const p = parseBrowserProfile(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.18363",
    );
    expect(shouldReduceEffects(p)).toBe(true);
  });

  it("does not reduce effects on modern Chrome", () => {
    const p = parseBrowserProfile(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
    expect(shouldReduceEffects(p, { hardwareConcurrency: 8, deviceMemory: 8, hasReadableStream: true })).toBe(false);
  });

  it("reduces effects when an old Web API is missing even if UA is hidden", () => {
    const p = parseBrowserProfile("Mozilla/5.0 AppleWebKit/537.36 Safari/537.36");
    expect(shouldReduceEffects(p, {
      hardwareConcurrency: 8,
      deviceMemory: 8,
      hasReadableStream: true,
      hasAbortController: false,
    })).toBe(true);
  });
});

describe("detectChromiumMajor", () => {
  it("prefers Edg/ over Chrome/ version", () => {
    expect(
      detectChromiumMajor(
        "Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36 Edg/118.0.2088.76",
      ),
    ).toBe(118);
  });

  it("parses Chromium/ token used by Linux distributions", () => {
    expect(detectChromiumMajor("Mozilla/5.0 Chromium/78.0.3904.108 Safari/537.36")).toBe(78);
  });
});
