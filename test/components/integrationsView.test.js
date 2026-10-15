const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");

const { createElement } = React;
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { findElement, installInteractiveDom } = require("../lib/interactiveDom");

const MOCKS = {
  "react-i18next": `
    const t = (key) => key;
    export const useTranslation = () => ({ t, i18n: { language: "en" } });
  `,
  "/stores/settingsStore": `
    export function useSettingsStore(selector) {
      return selector({
        gcalAccounts: globalThis.__gcalAccounts ?? [],
        mcalAccounts: [],
        appleCalendarConnected: false,
      });
    }
  `,
  "/hooks/useConnectorAccess": `
    export function useConnectorAccess() {
      return globalThis.__connectorAccess;
    }
  `,
  "/stores/connectorStatusStore": `
    export function useConnectorStatusStore(selector) {
      return selector({ statuses: globalThis.__connectorStatuses ?? {} });
    }
    export async function ensureConnectorStatus() {}
  `,
  "/connectors/connectorRows": `
    export const CONNECTOR_ROWS = [{ id: "gmail" }, { id: "slack" }, { id: "linear" }, { id: "github" }];
  `,
  "/ConnectorsSection": `
    import React from "react";
    export function ConnectorsSection() {
      React.useEffect(() => {
        globalThis.__connectorsMounts += 1;
      }, []);
      return React.createElement("div", null, "CONNECTORS SECTION");
    }
  `,
  "/ApiKeysSection": `
    import React from "react";
    export default function ApiKeysSection({ createRequest, onCanCreateChange }) {
      React.useEffect(() => { onCanCreateChange(true); }, [onCanCreateChange]);
      return React.createElement("div", null, "API KEYS SECTION create:" + createRequest);
    }
  `,
  "/integrations/CalendarsPane": `
    import React from "react";
    export function CalendarsPane() { return React.createElement("div", null, "CALENDARS PANE"); }
  `,
  "/ui/select": `
    import React from "react";
    const Pass = ({ children }) => React.createElement("div", null, children);
    export const Select = Pass;
    export const SelectContent = Pass;
    export const SelectTrigger = Pass;
    export const SelectValue = () => null;
    export const SelectItem = ({ children }) => React.createElement("span", null, children);
  `,
  "/ui/button": `
    import React from "react";
    export function Button(props) { return React.createElement("button", props); }
  `,
  "/ui/useToast": `
    export const useToast = () => ({ toast() {} });
  `,
};

const LOCAL_MCP_CONFIG = {
  mcpServers: {
    openwhispr: {
      command: "C:\\Program Files\\OpenWhispr\\OpenWhispr.exe",
      args: ["C:\\Program Files\\OpenWhispr\\resources\\app.asar\\local-mcp.cjs"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    },
  },
};

function click(element) {
  element.dispatchEvent({
    type: "click",
    bubbles: true,
    button: 0,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.cancelBubble = true;
    },
  });
}

const nav = (container) => findElement(container, (node) => node.tagName === "NAV");
const navButton = (container, section) =>
  findElement(
    nav(container),
    (node) =>
      node.tagName === "BUTTON" &&
      node.textContent.trim().startsWith(`integrations.nav.sections.${section}`)
  );
// Icons render whitespace text nodes, so labels are compared trimmed.
const label = (node) => node.textContent.trim();
// Sections stay mounted once opened; only the open one is shown.
const shownText = (node) => {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType === 1 && node.getAttribute("hidden") !== null) return "";
  return node.childNodes.map(shownText).join("");
};
// Focus checks compare as booleans: a failed assert would try to print the DOM.
const heading = (container, text) =>
  findElement(container, (node) => node.tagName === "H2" && label(node) === text);
const buttonWithText = (container, text) =>
  findElement(container, (node) => node.tagName === "BUTTON" && label(node) === text);

async function renderView(
  t,
  {
    isPaid = true,
    section = "connectors",
    statuses = {},
    gcalAccounts = [],
    connectorAccess = { available: true, blockedByOrg: false, connectorsAllowed: true },
    hostedServicesEnabled = true,
    getLocalMcpConfig = async () => LOCAL_MCP_CONFIG,
  } = {}
) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const openedUrls = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPlatform: () => "darwin",
        getLocalMcpConfig,
        openExternal(url) {
          openedUrls.push(url);
        },
      },
    },
  });
  globalThis.__connectorStatuses = statuses;
  globalThis.__gcalAccounts = gcalAccounts;
  globalThis.__connectorAccess = connectorAccess;
  globalThis.__connectorsMounts = 0;
  t.after(() => {
    delete globalThis.__connectorStatuses;
    delete globalThis.__gcalAccounts;
    delete globalThis.__connectorAccess;
    delete globalThis.__connectorsMounts;
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-integrations-view-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      ...MOCKS,
      "/config/fork.json": JSON.stringify({
        officialAccountEnabled: hostedServicesEnabled,
        hostedServicesEnabled,
      }),
    },
  });
  const { default: IntegrationsView } = await vite.ssrLoadModule(
    "/components/IntegrationsView.tsx"
  );
  const upgrades = { count: 0 };
  function Harness() {
    const [current, setCurrent] = React.useState(section);
    return createElement(IntegrationsView, {
      isPaid,
      onUpgrade: () => upgrades.count++,
      section: current,
      onSectionChange: setCurrent,
    });
  }
  root = createRoot(container);
  await React.act(async () => root.render(createElement(Harness)));
  return { container, upgrades, openedUrls };
}

test("sectionMeta shows counts on a paid plan and plan badges on a free one", async (t) => {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-integrations-sections-test-",
  });
  const { sectionMeta } = await vite.ssrLoadModule(
    "/components/integrations/integrationsSections.ts"
  );
  const connectors = (available, ready, blockedByOrg = false) => ({
    available,
    blockedByOrg,
    ready,
  });
  const paid = { isPaid: true, connectors: connectors(true, 2), connectedCalendars: 1 };
  const free = { isPaid: false, connectors: connectors(false, 0), connectedCalendars: 1 };
  const empty = { isPaid: true, connectors: connectors(true, 0), connectedCalendars: 0 };

  assert.deepEqual(sectionMeta("connectors", paid), { kind: "count", value: 2 });
  assert.deepEqual(sectionMeta("calendars", paid), { kind: "count", value: 1 });
  assert.equal(sectionMeta("api", paid), null);
  assert.equal(sectionMeta("mcp", paid), null);
  assert.equal(sectionMeta("cli", paid), null);

  assert.equal(sectionMeta("connectors", free), null);
  assert.deepEqual(sectionMeta("calendars", free), { kind: "count", value: 1 });
  assert.deepEqual(sectionMeta("api", free), { kind: "badge", badge: "pro" });
  // Hosted MCP: assert.deepEqual(sectionMeta("mcp", free), { kind: "badge", badge: "pro" });
  assert.equal(sectionMeta("mcp", free), null);
  assert.deepEqual(sectionMeta("cli", free), { kind: "badge", badge: "free" });

  assert.equal(sectionMeta("connectors", empty), null);
  assert.equal(sectionMeta("calendars", empty), null);

  // The organization turned connectors off: no plan badge and no count, on any plan.
  for (const isPaid of [true, false]) {
    const blocked = { ...paid, isPaid, connectors: connectors(isPaid, 2, true) };
    assert.equal(sectionMeta("connectors", blocked), null);
  }
});

test("the nav lists every section and switches the pane it shows", async (t) => {
  const { container } = await renderView(t);

  const order = [];
  findElement(nav(container), (node) => {
    if (node.tagName === "BUTTON" && label(node).startsWith("integrations.nav.sections.")) {
      order.push(label(node).replace(/^integrations\.nav\.sections\.([a-z]+).*$/, "$1"));
    }
    return false;
  });
  assert.deepEqual(order, ["calendars", "connectors", "api", "mcp", "cli"]);
  assert.equal(navButton(container, "connectors").getAttribute("aria-current"), "page");
  assert.match(container.textContent, /CONNECTORS SECTION/);

  await React.act(async () => click(navButton(container, "cli")));

  assert.equal(navButton(container, "cli").getAttribute("aria-current"), "page");
  assert.equal(navButton(container, "connectors").getAttribute("aria-current"), null);
  assert.doesNotMatch(shownText(container), /CONNECTORS SECTION/);
  assert.match(shownText(container), /npm install -g @openwhispr\/cli/);
});

test("a section keeps its state while another one is open", async (t) => {
  const { container } = await renderView(t);

  await React.act(async () => click(navButton(container, "api")));
  await React.act(async () => click(navButton(container, "connectors")));

  // A connect running in a connector row (GitHub's device code) would stop on unmount.
  assert.equal(globalThis.__connectorsMounts, 1);
  assert.match(shownText(container), /CONNECTORS SECTION/);
});

test("Calendars stays mounted from any section, so its listeners keep the nav count fresh", async (t) => {
  const { container } = await renderView(t, { section: "api" });

  assert.match(container.textContent, /CALENDARS PANE/);
  assert.doesNotMatch(shownText(container), /CALENDARS PANE/);
});

test("the section it's given opens first", async (t) => {
  const { container } = await renderView(t, { section: "calendars" });

  assert.equal(navButton(container, "calendars").getAttribute("aria-current"), "page");
  assert.match(shownText(container), /CALENDARS PANE/);
});

// Original hosted MCP behavior:
// test("MCP's Create API key step opens the API keys section and asks it to create one", async (t) => {
//   const { container } = await renderView(t, { section: "mcp" });
//
//   await React.act(async () => click(buttonWithText(container, "apiKeysSection.createButton")));
//
//   assert.equal(navButton(container, "api").getAttribute("aria-current"), "page");
//   assert.match(shownText(container), /API KEYS SECTION create:1/);
//   assert.equal(
//     container.ownerDocument.activeElement === heading(container, "integrations.nav.sections.api"),
//     true
//   );
// });

test("the API keys section links on to MCP and the command line", async (t) => {
  const { container } = await renderView(t, { section: "api" });

  const cliLink = findElement(
    container,
    (node) =>
      node.tagName === "BUTTON" &&
      node.textContent.trim() === "integrations.nav.sections.cli" &&
      !nav(container).contains(node)
  );
  await React.act(async () => click(cliLink));

  assert.equal(navButton(container, "cli").getAttribute("aria-current"), "page");
  // The link is hidden with its section, so focus moves to the opened one.
  assert.equal(
    container.ownerDocument.activeElement === heading(container, "integrations.nav.sections.cli"),
    true
  );
});

test("picking a section from the nav leaves focus on the nav", async (t) => {
  const { container } = await renderView(t);
  const cliButton = navButton(container, "cli");
  cliButton.focus();

  await React.act(async () => click(cliButton));

  assert.equal(container.ownerDocument.activeElement === cliButton, true);
});

test("a paid plan sees how many connectors and calendars are connected", async (t) => {
  const { container } = await renderView(t, {
    statuses: {
      gmail: { id: "gmail", connected: true },
      slack: { id: "slack", connected: true },
      linear: { id: "linear", connected: false },
      github: { id: "github", connected: true, needsReconnect: true },
    },
    gcalAccounts: [{ email: "a@acme.com" }],
  });

  assert.equal(label(navButton(container, "connectors")), "integrations.nav.sections.connectors2");
  assert.equal(label(navButton(container, "calendars")), "integrations.nav.sections.calendars1");
  assert.equal(label(navButton(container, "api")), "integrations.nav.sections.api");
});

test("the Connectors tag follows actual availability without advertising a paid plan", async (t) => {
  const { container } = await renderView(t, {
    isPaid: true,
    connectorAccess: { available: false, blockedByOrg: false, connectorsAllowed: false },
  });

  assert.equal(label(navButton(container, "connectors")), "integrations.nav.sections.connectors");
  assert.equal(label(navButton(container, "api")), "integrations.nav.sections.api");
});

test("a free plan sees plan badges, the API upsell, and no key list", async (t) => {
  const { container, upgrades } = await renderView(t, { isPaid: false, section: "api" });

  assert.equal(label(navButton(container, "connectors")), "integrations.nav.sections.connectors");
  // Hosted MCP used the "integrations.plan.pro" badge.
  assert.equal(label(navButton(container, "mcp")), "integrations.nav.sections.mcp");
  assert.equal(
    label(navButton(container, "cli")),
    "integrations.nav.sections.cliintegrations.cli.local.freeBadge"
  );
  assert.match(shownText(container), /integrations\.api\.proRequired/);
  assert.doesNotMatch(container.textContent, /API KEYS SECTION/);

  await React.act(async () => click(buttonWithText(container, "integrations.api.viewPlans")));
  assert.equal(upgrades.count, 1);
});

// Original hosted MCP behavior:
// test("a free plan still sees MCP's setup steps, with Create API key disabled", async (t) => {
//   const { container } = await renderView(t, { isPaid: false, section: "mcp" });
//
//   assert.match(container.textContent, /integrations\.mcp\.proRequired/);
//   assert.match(container.textContent, /https:\/\/mcp\.openwhispr\.com\/mcp/);
//   assert.notEqual(
//     buttonWithText(container, "apiKeysSection.createButton").getAttribute("disabled"),
//     null
//   );
// });

test("the API header opens the existing creation dialog through its request", async (t) => {
  const { container } = await renderView(t, { section: "api" });
  const createButton = buttonWithText(container, "apiKeysSection.createButton");
  assert.ok(createButton);
  assert.equal(createButton.getAttribute("disabled") !== null, false);
  await React.act(async () => click(createButton));
  assert.match(shownText(container), /API KEYS SECTION create:1/);
});

test("hosted API and CLI keep their docs while local MCP never opens the official MCP docs", async (t) => {
  const { container, openedUrls } = await renderView(t, { section: "api" });
  for (const [section, url] of [
    ["api", "https://docs.openwhispr.com/api/overview"],
    // Hosted MCP: ["mcp", "https://docs.openwhispr.com/integrations/mcp"],
    ["cli", "https://docs.openwhispr.com/cli/install"],
  ]) {
    await React.act(async () => click(navButton(container, section)));
    const pane = heading(container, `integrations.nav.sections.${section}`).parentNode.parentNode;
    await React.act(async () => click(buttonWithText(pane, "integrations.readDocs")));
    assert.equal(openedUrls.at(-1), url);
  }
  await React.act(async () => click(navButton(container, "mcp")));
  assert.doesNotMatch(shownText(container), /integrations\.readDocs/);
  assert.equal(openedUrls.length, 2);
});

// Original hosted MCP behavior:
// test("MCP offers OAuth and API-key alternatives on free and paid plans", async (t) => {
//   for (const isPaid of [true, false])
//     await t.test(String(isPaid), async (st) => {
//       const { container } = await renderView(st, { section: "mcp", isPaid });
//       assert.match(shownText(container), /integrations\.mcp\.oauthDescription/);
//       assert.match(shownText(container), /integrations\.mcp\.apiKeyDescription/);
//       assert.match(shownText(container), /Authorization: Bearer YOUR_API_KEY/);
//       assert.equal(
//         buttonWithText(container, "apiKeysSection.createButton").getAttribute("disabled") !== null,
//         !isPaid
//       );
//     });
// });

test("local build keeps MCP and CLI available without hosted API, login or upsell", async (t) => {
  const { container, upgrades } = await renderView(t, {
    isPaid: false,
    section: "cli",
    hostedServicesEnabled: false,
  });
  assert.equal(navButton(container, "api"), null);
  // Before local MCP: assert.equal(navButton(container, "mcp"), null);
  assert.equal(label(navButton(container, "mcp")), "integrations.nav.sections.mcp");
  assert.ok(navButton(container, "connectors"));
  assert.match(shownText(container), /openwhispr --local notes list/);
  assert.doesNotMatch(
    shownText(container),
    /openwhispr auth login|integrations\.cli\.viewPlans|integrations\.cli\.cloud\.label/
  );
  assert.equal(upgrades.count, 0);
});

test("a stale hosted integration deep link resolves to calendars in the local build", async (t) => {
  const { container } = await renderView(t, { section: "api", hostedServicesEnabled: false });
  assert.equal(navButton(container, "calendars").getAttribute("aria-current"), "page");
  assert.match(shownText(container), /CALENDARS PANE/);
  assert.doesNotMatch(container.textContent, /API KEYS SECTION/);
});

test("local MCP copies the exact client JSON on a free plan without opening API setup", async (t) => {
  const { container, upgrades, openedUrls } = await renderView(t, {
    isPaid: false,
    section: "mcp",
    hostedServicesEnabled: false,
  });
  const clipboardWrites = [];
  const originalClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value) => {
        clipboardWrites.push(value);
      },
    },
  });
  t.after(() => {
    if (originalClipboard)
      Object.defineProperty(globalThis.navigator, "clipboard", originalClipboard);
    else delete globalThis.navigator.clipboard;
  });

  assert.equal(navButton(container, "mcp").getAttribute("aria-current"), "page");
  assert.equal(navButton(container, "api"), null);
  assert.match(shownText(container), /integrations\.mcp\.localRequirements/);
  assert.doesNotMatch(
    shownText(container),
    /mcp\.openwhispr\.com|oauth|apiKey|proRequired|Authorization:/
  );
  const originalSetTimeout = globalThis.setTimeout;
  let resetCopy;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if (delay === 2000) {
      resetCopy = callback;
      return 0;
    }
    return originalSetTimeout(callback, delay, ...args);
  });
  const copy = findElement(
    container,
    (node) => node.getAttribute?.("aria-label") === "integrations.mcp.copyConfig"
  );
  assert.ok(copy);
  await React.act(async () => click(copy));
  assert.equal(clipboardWrites.length, 1);
  assert.deepEqual(JSON.parse(clipboardWrites[0]), LOCAL_MCP_CONFIG);
  assert.match(clipboardWrites[0], /\n {2}"mcpServers"/);
  await React.act(async () => resetCopy());
  assert.equal(upgrades.count, 0);
  assert.deepEqual(openedUrls, []);
});

test("MCP configuration failure exposes retry and a successful retry replaces the error", async (t) => {
  let attempts = 0;
  const { container } = await renderView(t, {
    section: "mcp",
    hostedServicesEnabled: false,
    getLocalMcpConfig: async () => {
      if (++attempts === 1) throw new Error("unavailable");
      return LOCAL_MCP_CONFIG;
    },
  });
  assert.match(shownText(container), /integrations\.mcp\.configLoadFailed/);
  assert.doesNotMatch(shownText(container), /"mcpServers"/);
  await React.act(async () => click(buttonWithText(container, "common.retry")));
  assert.equal(attempts, 2);
  assert.doesNotMatch(shownText(container), /integrations\.mcp\.configLoadFailed/);
  assert.match(shownText(container), /"mcpServers"/);
});

test("MCP waits for local configuration and stays mounted when visiting another integration", async (t) => {
  let finish;
  let requests = 0;
  const { container } = await renderView(t, {
    section: "mcp",
    hostedServicesEnabled: false,
    getLocalMcpConfig: () => {
      requests++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  assert.match(shownText(container), /common\.loading/);
  assert.doesNotMatch(shownText(container), /"mcpServers"/);
  await React.act(async () => finish(LOCAL_MCP_CONFIG));
  assert.doesNotMatch(shownText(container), /common\.loading/);
  assert.match(shownText(container), /"mcpServers"/);
  await React.act(async () => click(navButton(container, "calendars")));
  await React.act(async () => click(navButton(container, "mcp")));
  assert.equal(requests, 1);
  assert.match(shownText(container), /"mcpServers"/);
});
