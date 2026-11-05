import { defineManifest } from "@crxjs/vite-plugin";

// match_origin_as_fallback is missing from the CRXJS manifest type; a non-literal object skips that check.
const contentScript = {
  matches: ["<all_urls>"],
  js: ["src/content/index.ts"],
  run_at: "document_idle" as const,
  all_frames: true,
  match_about_blank: true,
  match_origin_as_fallback: true,
};

export default defineManifest({
  manifest_version: 3,
  name: "AutoApply",
  version: "1.0.0",
  description: "Autofills job applications on any site using your profile.",
  minimum_chrome_version: "120",
  action: { default_popup: "src/popup/index.html", default_title: "AutoApply" },
  options_page: "src/options/index.html",
  background: { service_worker: "src/background/sw.ts", type: "module" },
  content_scripts: [
    contentScript,
    {
      ...contentScript,
      js: ["src/content/scrollLock.ts", "src/content/pageTimers.ts"],
      run_at: "document_start" as const,
      world: "MAIN" as const,
    },
  ],
  // YOLO mode: alarms (its timer), offscreen + declarativeNetRequest (the hidden page it applies in; offscreen also
  // compiles tailored résumés), tabGroups (its
  // background-tab fallback), notifications ("needs you"), identity (Gmail, for verification emails).
  permissions: [
    "storage",
    "unlimitedStorage",
    "scripting",
    "tabs",
    "alarms",
    "offscreen",
    "declarativeNetRequestWithHostAccess",
    "tabGroups",
    "notifications",
    "identity",
    // Real clicks and keys for YOLO on bot-checked pages (background/yolo/realInput.ts). Chrome refuses it as optional.
    "debugger",
    // Test-harness builds only (tools/yolo-sweep/build.mjs): a headless browser can't show the permission prompt.
    ...(process.env.AA_NATIVE_REQUIRED === "1" ? (["nativeMessaging"] as const) : []),
  ],
  // Claude through the user's own Claude Code (background/claude/bridge.ts); asked for only when chosen.
  optional_permissions: process.env.AA_NATIVE_REQUIRED === "1" ? [] : ["nativeMessaging"],
  host_permissions: ["<all_urls>"],
  // The bundled pdfLaTeX (public/latex) is WebAssembly, for AI résumé tailoring. Only the extension's own code runs.
  content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
  commands: {
    _execute_action: { suggested_key: { default: "Alt+Shift+A" } },
    "fill-page": {
      suggested_key: { default: "Alt+Shift+F" },
      description: "Autofill the job application on this page",
    },
    "toggle-overlay": {
      suggested_key: { default: "Alt+Shift+W" },
      description: "Expand or collapse the AutoApply panel",
    },
  },
  icons: { "16": "icons/16.png", "48": "icons/48.png", "128": "icons/128.png" },
});
