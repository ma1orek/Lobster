import { app, BrowserWindow, ipcMain, WebContentsView, View, session, nativeImage, Menu, clipboard, screen } from 'electron';
import * as path from 'path';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

if (require('electron-squirrel-startup')) {
  app.quit();
}

// Allow video autoplay with sound in browser tabs (no user gesture required)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Chrome-like user-agent: Google blocks "Electron" UA from OAuth/SSO flows
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`;

// ── Browser tab management ──────────────────────────────────────────
interface Tab {
  id: number;
  view: WebContentsView;
  url: string;
  title: string;
}

let mainWindow: BrowserWindow | null = null;
let rootView: View | null = null;
let mainWebView: WebContentsView | null = null;
const tabs: Map<number, Tab> = new Map();
let activeTabId: number | null = null;
let agentTabId: number | null = null; // Agent's working tab (legacy fallback)
const agentTabs: Map<string, number> = new Map(); // taskId → tabId (multi-tab executor)
let ghostTabId: number | null = null; // Hidden agent tab — NOT shown in tab bar, user keeps working
const privateTabIds = new Set<number>(); // Tabs hidden from AI — agent can't see/access
let splitTabId: number | null = null; // Split view: second tab shown on right half
let nextTabId = 1;
let screenshotInterval: ReturnType<typeof setInterval> | null = null;

// Chrome bar height: 0 = idle full-screen, 84+ = browsing mode (2 rows: tabs + URL bar)
const CHROME_H_BROWSING = 84;
let chromeH = 0; // starts in idle (full screen)
let rightPanelW = 0; // right panel width (task history drawer)

// Safe sender — prevents TypeError when webContents is destroyed
function sendToUI(channel: string, ...args: any[]) {
  try {
    if (mainWebView && !mainWebView.webContents.isDestroyed()) {
      mainWebView.webContents.send(channel, ...args);
    }
  } catch { /* silently ignore — window closing */ }
}

// Safe tab getter — returns null if tab doesn't exist or is destroyed
function safeTab(id: number | null): Tab | null {
  if (id === null) return null;
  const tab = tabs.get(id);
  if (!tab) return null;
  try {
    if (tab.view.webContents.isDestroyed()) {
      tabs.delete(id);
      if (agentTabId === id) agentTabId = null;
      for (const [taskId, tabId] of agentTabs) {
        if (tabId === id) agentTabs.delete(taskId);
      }
      return null;
    }
  } catch {
    tabs.delete(id);
    return null;
  }
  return tab;
}

function getContentBounds(): Electron.Rectangle {
  if (!mainWindow) return { x: 0, y: chromeH, width: 800 - rightPanelW, height: 600 - chromeH };
  const [width, height] = mainWindow.getContentSize();
  return { x: 0, y: chromeH, width: width - rightPanelW, height: height - chromeH };
}

// ALL tabs use getContentBounds() which starts at y=chromeH (84px in browsing mode).
// No tab can ever cover the chrome bar area.

function updateChromeH(h: number) {
  if (h === chromeH) return; // No change — skip expensive z-order recalc
  chromeH = h;
  if (!mainWebView || !mainWindow) return;
  const [w, height] = mainWindow.getContentSize();
  // When h=0 (idle), mainWebView fills full window; otherwise only top strip
  mainWebView.setBounds({ x: 0, y: 0, width: w, height: h === 0 ? height : h });
  // Update ALL tab bounds — prevents any tab from having stale full-window positioning
  const bounds = getContentBounds();
  for (const [tid, t] of tabs) {
    try { if (!t.view.webContents.isDestroyed()) t.view.setBounds(bounds); } catch { /* destroyed */ }
  }
  // Always re-assert z-order so mainWebView (chrome bar) stays on top
  ensureZOrder();
}

/** Ensure z-order: agent tabs (bottom) → ghost tab → active tab → mainWebView (top).
 *  Call after ANY rootView child modification so the chrome bar is never covered.
 *  Agent tabs stay visible (behind active) so capturePage() works for background screenshots. */
function ensureZOrder() {
  if (!rootView || !mainWebView) return;
  // Collect all agent tab IDs that need to stay visible for background capture
  const agentTabIds = new Set<number>();
  for (const [, tabId] of agentTabs) agentTabIds.add(tabId);
  if (agentTabId !== null) agentTabIds.add(agentTabId);

  // Check if active tab is a "new tab" (start page) — agent tabs must be hidden to avoid bleeding through
  const activeIsNewTab = activeTabId !== null && (() => {
    const t = tabs.get(activeTabId!);
    return t && (!t.url || t.url === 'about:blank');
  })();

  // Build desired order: [agent tabs..., ghost, split, active, mainWebView]
  const desired: View[] = [];
  for (const atid of agentTabIds) {
    if (atid === activeTabId || atid === ghostTabId) continue;
    const at = tabs.get(atid);
    if (at && !at.view.webContents.isDestroyed()) desired.push(at.view);
  }
  if (ghostTabId !== null) {
    const gt = tabs.get(ghostTabId);
    if (gt && !gt.view.webContents.isDestroyed()) desired.push(gt.view);
  }
  if (splitTabId !== null && splitTabId !== activeTabId) {
    const st = tabs.get(splitTabId);
    if (st && !st.view.webContents.isDestroyed()) desired.push(st.view);
  }
  if (activeTabId !== null) {
    const at = tabs.get(activeTabId);
    if (at && !at.view.webContents.isDestroyed()) desired.push(at.view);
  }
  desired.push(mainWebView);

  // Check if current children order already matches desired
  const current = rootView.children;
  let orderCorrect = current.length === desired.length;
  if (orderCorrect) {
    for (let i = 0; i < desired.length; i++) {
      if (current[i] !== desired[i]) { orderCorrect = false; break; }
    }
  }

  // Only do the expensive remove/add dance if order actually changed
  if (!orderCorrect) {
    // Remove all, re-add in correct order
    for (const child of [...current]) {
      try { rootView.removeChildView(child); } catch { /* ok */ }
    }
    for (const child of desired) {
      rootView.addChildView(child);
    }
  }

  // Set visibility (cheap — no flicker)
  for (const [tid, t] of tabs) {
    try {
      if (t.view.webContents.isDestroyed()) continue;
      if (tid === activeTabId || tid === splitTabId) {
        t.view.setVisible(true);
      } else if (tid === ghostTabId) {
        t.view.setVisible(true);
      } else if (agentTabIds.has(tid)) {
        t.view.setVisible(!activeIsNewTab);
      } else {
        t.view.setVisible(false);
      }
    } catch { /* destroyed */ }
  }
}

// Get tab IDs that are user-visible (exclude ghost tabs — they're hidden agent tabs)
function getUserTabKeys(): number[] {
  return Array.from(tabs.keys()).filter(id => id !== ghostTabId);
}

// Register keyboard shortcuts on a tab's webContents (called from createTab and createWindow)
function registerTabShortcuts(view: WebContentsView) {
  view.webContents.on('before-input-event', (_event, input) => {
    if (!mainWindow || input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;

    // Tab management
    if (ctrl && !input.shift && input.key.toLowerCase() === 't') { createTab(''); }
    if (ctrl && !input.shift && input.key.toLowerCase() === 'w') { if (activeTabId !== null) closeTab(activeTabId); }
    if (ctrl && !input.shift && input.key === 'Tab') {
      const tabKeys = getUserTabKeys();
      if (tabKeys.length > 1 && activeTabId !== null) {
        const idx = tabKeys.indexOf(activeTabId);
        switchToTab(tabKeys[(idx + 1) % tabKeys.length]);
      }
    }
    if (ctrl && input.shift && input.key === 'Tab') {
      const tabKeys = getUserTabKeys();
      if (tabKeys.length > 1 && activeTabId !== null) {
        const idx = tabKeys.indexOf(activeTabId);
        switchToTab(tabKeys[(idx - 1 + tabKeys.length) % tabKeys.length]);
      }
    }
    if (ctrl && !input.shift && input.key >= '1' && input.key <= '9') {
      const tabKeys = getUserTabKeys();
      const idx2 = parseInt(input.key) - 1;
      if (idx2 < tabKeys.length) switchToTab(tabKeys[idx2]);
    }
    // Navigation
    if (ctrl && !input.shift && input.key.toLowerCase() === 'l') { sendToUI('focus-url-bar'); }
    if (input.alt && !ctrl && input.key === 'ArrowLeft') {
      if (activeTabId !== null) { const tab = tabs.get(activeTabId); if (tab && tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack(); }
    }
    if (input.alt && !ctrl && input.key === 'ArrowRight') {
      if (activeTabId !== null) { const tab = tabs.get(activeTabId); if (tab && tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward(); }
    }
    if ((ctrl && !input.shift && input.key.toLowerCase() === 'r') || input.key === 'F5') {
      if (activeTabId !== null) { const tab = tabs.get(activeTabId); if (tab) tab.view.webContents.reload(); }
    }
    // Features
    if (ctrl && !input.shift && input.key.toLowerCase() === 'f') { sendToUI('toggle-find-in-page'); }
    if (ctrl && !input.shift && input.key.toLowerCase() === 'k') { sendToUI('toggle-command-palette'); }
    if (ctrl && !input.shift && input.key.toLowerCase() === 'p') {
      if (activeTabId !== null) { const tab = tabs.get(activeTabId); if (tab) tab.view.webContents.print(); }
    }
    if (ctrl && !input.shift && input.key === '\\') { sendToUI('toggle-split-view'); }
    if (input.key === 'Escape') { sendToUI('escape-pressed'); }
    // Zoom
    if (ctrl && !input.shift && (input.key === '=' || input.key === '+')) {
      if (activeTabId !== null) { const tab = tabs.get(activeTabId); if (tab) { const z = Math.min(tab.view.webContents.getZoomFactor() + 0.1, 3.0); tab.view.webContents.setZoomFactor(z); sendToUI('zoom-changed', Math.round(z * 100)); } }
    }
    if (ctrl && !input.shift && input.key === '-') {
      if (activeTabId !== null) { const tab = tabs.get(activeTabId); if (tab) { const z = Math.max(tab.view.webContents.getZoomFactor() - 0.1, 0.3); tab.view.webContents.setZoomFactor(z); sendToUI('zoom-changed', Math.round(z * 100)); } }
    }
    if (ctrl && !input.shift && input.key === '0') {
      if (activeTabId !== null) { const tab = tabs.get(activeTabId); if (tab) { tab.view.webContents.setZoomFactor(1.0); sendToUI('zoom-changed', 100); } }
    }
    // DevTools
    if (input.key === 'F12') { if (activeTabId !== null) { const tab = tabs.get(activeTabId); if (tab) tab.view.webContents.toggleDevTools(); } }
    if (ctrl && input.shift && input.key.toLowerCase() === 'i') { if (activeTabId !== null) { const tab = tabs.get(activeTabId); if (tab) tab.view.webContents.toggleDevTools(); } }
  });
}

function createTab(url: string, switchTo = true): Tab {
  const id = nextTabId++;
  const view = new WebContentsView({
    webPreferences: {
      backgroundThrottling: false, // Agent tabs must keep rendering in background for screenshots + drawing
    },
  });

  // Register keyboard shortcuts on this tab's webContents
  registerTabShortcuts(view);

  view.webContents.on('did-navigate', (_e, navUrl) => {
    const tab = tabs.get(id);
    if (tab) {
      const wasNewTab = !tab.url || tab.url === 'about:blank';
      tab.url = navUrl;
      // Notify React for ALL tabs including agent (co-worker model — visible in tab bar)
      mainWindow?.webContents.send('tab-updated', { id, url: navUrl, title: tab.title });
      // If navigating away from new tab, restore normal layout
      if (wasNewTab && navUrl && navUrl !== 'about:blank' && activeTabId === id) {
        updateChromeH(CHROME_H_BROWSING);
        if (!rootView?.children.includes(view)) {
          rootView?.addChildView(view);
        }
        view.setBounds(getContentBounds());
        view.setVisible(true);
        ensureZOrder();
      }
    }
  });

  // Inject overlay CSS + ad blocker CSS + cookie dismiss on page load
  view.webContents.on('dom-ready', () => {
    const wc = view.webContents;
    if (wc.isDestroyed()) return;
    wc.executeJavaScript(INJECT_OVERLAY_CSS).catch(() => {});
    // Skip ad blocking on Google apps, GitHub, YouTube — they break
    const pageUrl = wc.getURL() || '';
    const skipAdBlock = /mail\.google|docs\.google|drive\.google|calendar\.google|accounts\.google|youtube\.com|github\.com|stackoverflow\.com|notion\.so|figma\.com|excalidraw\.com|onet\.pl|wp\.pl|interia\.pl|gazeta\.pl|tvn24\.pl/.test(pageUrl);
    if (!skipAdBlock) wc.executeJavaScript(HIDE_ADS_CSS).catch(() => {});
    // Cookie dismiss: immediate + observer for late-loading banners
    wc.executeJavaScript(DISMISS_COOKIES_JS).catch(() => {});
    setTimeout(() => { if (!wc.isDestroyed()) wc.executeJavaScript(COOKIE_OBSERVER_JS).catch(() => {}); }, 500);
    setTimeout(() => { if (!wc.isDestroyed()) wc.executeJavaScript(DISMISS_COOKIES_JS).catch(() => {}); }, 1500);
    setTimeout(() => { if (!wc.isDestroyed()) wc.executeJavaScript(DISMISS_COOKIES_JS).catch(() => {}); }, 3000);
  });

  // Auto-focus on user interaction so clicks/keyboard work
  view.webContents.on('did-finish-load', () => {
    if (activeTabId === id) {
      view.webContents.focus();
    }
  });

  // Handle new-window requests (popups, target="_blank", window.open, OAuth flows)
  // Route them into Lobster tabs instead of opening separate OS windows
  view.webContents.setWindowOpenHandler(({ url, disposition }) => {
    // OAuth & sign-in flows: navigate IN-PLACE so redirect chain completes naturally
    // (opening in new tab breaks redirect back to the originating site)
    const isOAuth = url.includes('accounts.google.com') || url.includes('accounts.youtube.com') ||
        url.includes('oauth') || url.includes('signin/oauth') || url.includes('/sso');
    if (isOAuth) {
      view.webContents.loadURL(url);
      return { action: 'deny' };
    }
    // Regular login/auth pages: open in new tab
    if (url.includes('login') || url.includes('signin') || url.includes('auth')) {
      createTab(url);
      return { action: 'deny' };
    }
    // For everything else: if this is the AGENT tab, navigate in-place (don't create visible tabs)
    // For user tabs: open as new Lobster tab
    if (url && url !== 'about:blank') {
      if (id === agentTabId) {
        view.webContents.loadURL(url);
      } else {
        createTab(url);
      }
    }
    return { action: 'deny' };
  });

  // Handle window.open() that creates blank windows then navigates
  view.webContents.on('did-create-window', (childWindow) => {
    const childUrl = childWindow.webContents.getURL();
    if (childUrl && childUrl !== 'about:blank') {
      createTab(childUrl);
    }
    // Listen for navigation in the child window
    childWindow.webContents.on('will-navigate', (_e, navUrl) => {
      createTab(navUrl);
      childWindow.close();
    });
    // Close the popup window — we handle everything in tabs
    setTimeout(() => {
      if (!childWindow.isDestroyed()) childWindow.close();
    }, 500);
  });

  // Right-click context menu — standard browser actions
  view.webContents.on('context-menu', (_e, params) => {
    const menuItems: Electron.MenuItemConstructorOptions[] = [];
    if (params.linkURL) {
      menuItems.push({ label: 'Open Link in New Tab', click: () => createTab(params.linkURL) });
      menuItems.push({ label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) });
      menuItems.push({ type: 'separator' });
    }
    if (params.selectionText) {
      menuItems.push({ label: 'Copy', role: 'copy' });
    }
    if (params.isEditable) {
      menuItems.push({ label: 'Cut', role: 'cut' });
      menuItems.push({ label: 'Copy', role: 'copy' });
      menuItems.push({ label: 'Paste', role: 'paste' });
      menuItems.push({ label: 'Select All', role: 'selectAll' });
      menuItems.push({ type: 'separator' });
    }
    if (params.mediaType === 'image') {
      menuItems.push({ label: 'Copy Image', click: () => view.webContents.copyImageAt(params.x, params.y) });
      menuItems.push({ label: 'Save Image As...', click: () => view.webContents.downloadURL(params.srcURL) });
      menuItems.push({ type: 'separator' });
    }
    menuItems.push({ label: 'Back', enabled: view.webContents.canGoBack(), click: () => view.webContents.goBack() });
    menuItems.push({ label: 'Forward', enabled: view.webContents.canGoForward(), click: () => view.webContents.goForward() });
    menuItems.push({ label: 'Reload', click: () => view.webContents.reload() });
    menuItems.push({ type: 'separator' });
    menuItems.push({ label: 'Inspect Element', click: () => { view.webContents.inspectElement(params.x, params.y); } });
    if (menuItems.length > 0) Menu.buildFromTemplate(menuItems).popup();
  });

  view.webContents.on('page-title-updated', (_e, title) => {
    const tab = tabs.get(id);
    if (tab) {
      tab.title = title;
      // Notify React for ALL tabs including agent (co-worker model — visible in tab bar)
      mainWindow?.webContents.send('tab-updated', { id, url: tab.url, title });
    }
  });

  const tab: Tab = { id, view, url, title: 'New Tab' };
  tabs.set(id, tab);

  if (url) {
    const fullUrl = url.startsWith('http') ? url : `https://${url}`;
    view.webContents.loadURL(fullUrl);
  } else {
    // New tab: transparent about:blank — React UI shows StartPage through mainWebView
    view.webContents.loadURL('about:blank');
    view.webContents.on('dom-ready', () => {
      if (!view.webContents.isDestroyed()) {
        view.webContents.executeJavaScript(`document.body.style.background='#050505'`).catch(() => {});
      }
    });
  }

  if (switchTo) {
    // Always set chrome bar when creating a user-visible tab
    // (can't rely on tabs.size===1 because agent may have a background tab already)
    updateChromeH(CHROME_H_BROWSING);
    switchToTab(id);
    // Notify React UI — user tab appears in tab bar
    mainWindow?.webContents.send('tab-created', { id, url, title: 'New Tab' });
  } else {
    // Agent tab: works 100% in background via CDP — no visual tab switching needed.
    // User CAN click on this tab to watch agent's work.
    if (chromeH === 0) updateChromeH(CHROME_H_BROWSING);
    if (rootView) {
      if (!rootView.children.includes(view)) {
        rootView.addChildView(view);
      }
      view.setBounds(getContentBounds());
      view.setVisible(false); // Hidden behind active tab — CDP captures regardless
      ensureZOrder(); // Only reorders if order actually changed
    }
    // Notify React — show in tab bar with agent indicator
    mainWindow?.webContents.send('tab-created', { id, url, title: '🦞 Agent', isAgent: true });
  }
  return tab;
}

function getSplitBounds(side: 'left' | 'right'): Electron.Rectangle {
  const full = getContentBounds();
  const halfW = Math.round(full.width / 2);
  if (side === 'left') return { x: full.x, y: full.y, width: halfW - 1, height: full.height };
  return { x: full.x + halfW + 1, y: full.y, width: full.width - halfW - 1, height: full.height };
}

function switchToTab(id: number): void {
  if (!mainWindow || !rootView) return;
  const tab = tabs.get(id);
  if (!tab) return;

  const isNewTab = !tab.url || tab.url === 'about:blank';

  // Collect agent tab IDs — they must stay visible for background work (screenshots, drawing)
  const agentTabIdsSet = new Set<number>();
  for (const [, tabId] of agentTabs) agentTabIdsSet.add(tabId);
  if (agentTabId !== null) agentTabIdsSet.add(agentTabId);

  // Show active tab + split tab, hide others.
  // Agent tabs stay visible for background work EXCEPT when user is on New Tab (start page).
  // On New Tab, agent tab content bleeds through transparent mainWebView → must hide.
  for (const [tid, t] of tabs) {
    try {
      if (t.view.webContents.isDestroyed()) continue;
    } catch { continue; }
    if (tid === id) {
      if (isNewTab) {
        t.view.setVisible(false);
      } else {
        if (!rootView.children.includes(t.view)) rootView.addChildView(t.view);
        t.view.setBounds(splitTabId !== null ? getSplitBounds('left') : getContentBounds());
        t.view.setVisible(true);
      }
    } else if (splitTabId !== null && tid === splitTabId) {
      if (!rootView.children.includes(t.view)) rootView.addChildView(t.view);
      t.view.setBounds(getSplitBounds('right'));
      t.view.setVisible(true);
    } else if (tid !== ghostTabId) {
      if (isNewTab) {
        // New Tab active: hide ALL other tabs (including agent) so start page is clean
        t.view.setVisible(false);
      } else if (!agentTabIdsSet.has(tid)) {
        // Regular tab active: hide non-agent tabs, keep agent tabs for background work
        t.view.setVisible(false);
      }
    }
  }

  activeTabId = id;

  if (isNewTab && mainWebView && mainWindow) {
    // Check if there are other user-visible tabs — if so, keep chrome bar visible
    const hasOtherUserTabs = getUserTabKeys().some(tid => tid !== id);
    if (hasOtherUserTabs) {
      // Keep chrome bar: mainWebView fills from top to show chrome + start page
      const [w, h] = mainWindow.getContentSize();
      chromeH = CHROME_H_BROWSING;
      mainWebView.setBounds({ x: 0, y: 0, width: w, height: h });
    } else {
      // No other tabs: full idle mode
      const [w, h] = mainWindow.getContentSize();
      chromeH = 0;
      mainWebView.setBounds({ x: 0, y: 0, width: w, height: h });
    }
  } else {
    updateChromeH(CHROME_H_BROWSING);
  }

  // ALWAYS re-assert z-order — mainWebView (chrome bar) must stay topmost
  ensureZOrder();
  if (!isNewTab) tab.view.webContents.focus();
  mainWindow?.webContents?.send('tab-switched', { id });
}

function closeTab(id: number): void {
  const tab = tabs.get(id);
  if (!tab || !mainWindow || !rootView) return;

  try { rootView.removeChildView(tab.view); } catch {}
  try { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close(); } catch {}
  tabs.delete(id);

  // Reset agent tab if it was the one being closed
  if (agentTabId === id) agentTabId = null;
  // Clean up agentTabs entries pointing to this tab
  for (const [taskId, tabId] of agentTabs) {
    if (tabId === id) agentTabs.delete(taskId);
  }

  if (activeTabId === id) {
    // Find remaining user-visible tabs (exclude ghost + agent tabs)
    const remaining = Array.from(tabs.keys());
    const userTabs = remaining.filter(tid => tid !== agentTabId && tid !== ghostTabId);
    if (userTabs.length > 0) {
      switchToTab(userTabs[userTabs.length - 1]);
    } else {
      activeTabId = null;
      // No user tabs left: return to idle full-screen mode
      updateChromeH(0);
    }
  }

  mainWindow?.webContents?.send('tab-closed', { id });
}

// ── Ghost Tab: Hidden agent tab — NOT in tab bar, user keeps working ──
function createGhostTab(url: string): Tab {
  const id = nextTabId++;
  const view = new WebContentsView();

  // Register shortcuts so agent tab also responds to global shortcuts
  registerTabShortcuts(view);

  view.webContents.on('did-navigate', (_e, navUrl) => {
    const tab = tabs.get(id);
    if (tab) {
      tab.url = navUrl;
      tab.title = view.webContents.getTitle() || navUrl;
      // Notify React of ghost tab progress (for indicator pill)
      mainWindow?.webContents.send('ghost-tab-updated', { id, url: navUrl, title: tab.title });
    }
  });

  view.webContents.on('page-title-updated', (_e, title) => {
    const tab = tabs.get(id);
    if (tab) {
      tab.title = title;
      mainWindow?.webContents.send('ghost-tab-updated', { id, url: tab.url, title });
    }
  });

  // Inject same CSS/cookie handlers
  view.webContents.on('dom-ready', () => {
    const wc = view.webContents;
    if (wc.isDestroyed()) return;
    wc.executeJavaScript(INJECT_OVERLAY_CSS).catch(() => {});
    const pageUrl = wc.getURL() || '';
    const skipAdBlock = /mail\.google|docs\.google|drive\.google|calendar\.google|accounts\.google|youtube\.com|github\.com|stackoverflow\.com|notion\.so|figma\.com|excalidraw\.com|onet\.pl|wp\.pl|interia\.pl|gazeta\.pl|tvn24\.pl/.test(pageUrl);
    if (!skipAdBlock) wc.executeJavaScript(HIDE_ADS_CSS).catch(() => {});
    wc.executeJavaScript(DISMISS_COOKIES_JS).catch(() => {});
    setTimeout(() => { if (!wc.isDestroyed()) wc.executeJavaScript(COOKIE_OBSERVER_JS).catch(() => {}); }, 500);
    setTimeout(() => { if (!wc.isDestroyed()) wc.executeJavaScript(DISMISS_COOKIES_JS).catch(() => {}); }, 1500);
  });

  // Handle popups in ghost tab
  view.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    if (openUrl && openUrl !== 'about:blank') {
      view.webContents.loadURL(openUrl);
    }
    return { action: 'deny' };
  });

  // Context menu (basic)
  view.webContents.on('context-menu', (_e, params) => {
    const menuItems: Electron.MenuItemConstructorOptions[] = [];
    if (params.linkURL) {
      menuItems.push({ label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) });
    }
    menuItems.push({ label: 'Inspect Element', click: () => view.webContents.inspectElement(params.x, params.y) });
    if (menuItems.length > 0) Menu.buildFromTemplate(menuItems).popup();
  });

  const tab: Tab = { id, view, url, title: 'Agent working...' };
  tabs.set(id, tab);

  // Load URL
  if (url) {
    const fullUrl = url.startsWith('http') ? url : `https://${url}`;
    view.webContents.loadURL(fullUrl);
  }

  // Add to rootView but BEHIND active tab (invisible to user)
  if (rootView) {
    rootView.addChildView(view);
    view.setBounds(getContentBounds());
    view.setVisible(true); // Must be visible for capturePage to work
    ensureZOrder(); // Puts mainWebView on top so ghost tab is hidden
  }

  // Set as agent tab
  ghostTabId = id;
  agentTabId = id;

  // Notify React — ghost tab started (for floating indicator pill)
  mainWindow?.webContents.send('ghost-tab-started', { id, url, title: 'Agent working...' });

  return tab;
}

function closeGhostTab(): void {
  if (ghostTabId === null) return;
  const tab = tabs.get(ghostTabId);
  if (tab && rootView) {
    rootView.removeChildView(tab.view);
    tab.view.webContents.close();
    tabs.delete(ghostTabId);
  }
  if (agentTabId === ghostTabId) agentTabId = null;
  mainWindow?.webContents.send('ghost-tab-ended', { id: ghostTabId });
  ghostTabId = null;
}

async function captureActiveTab(): Promise<Buffer | null> {
  if (activeTabId === null) return null;
  const tab = tabs.get(activeTabId);
  if (!tab) return null;

  try {
    const image = await capturePageClean(tab.view.webContents);
    const natural = image.getSize();
    const scale = 768 / Math.max(natural.width, natural.height, 1);
    const resized = image.resize({
      width: Math.round(natural.width * scale),
      height: Math.round(natural.height * scale),
    });
    return resized.toJPEG(85);
  } catch {
    return null;
  }
}

// ── OpenClaw-inspired: Extract interactive page elements ─────────

const PAGE_SNAPSHOT_JS = `
(function() {
  var selectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick], [tabindex]:not([tabindex="-1"])';
  var elements = document.querySelectorAll(selectors);
  var results = [];

  for (var i = 0; i < elements.length && results.length < 50; i++) {
    var el = elements[i];
    var rect = el.getBoundingClientRect();
    if (rect.width < 5 || rect.height < 5) continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
    if (rect.right < 0 || rect.left > window.innerWidth) continue;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute('role') || tag;
    var text = (el.textContent || '').trim().replace(/\\s+/g, ' ').substring(0, 60);
    var ariaLabel = el.getAttribute('aria-label') || '';
    var placeholder = el.getAttribute('placeholder') || '';
    var value = el.value || '';
    var type = el.getAttribute('type') || '';

    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var x = Math.round((cx / window.innerWidth) * 768);
    var y = Math.round((cy / window.innerHeight) * 768);

    var label = ariaLabel || text || placeholder || value || (tag + '[' + type + ']');
    results.push({
      ref: 'e' + results.length,
      role: role,
      label: label.substring(0, 80),
      x: x, y: y, tag: tag, type: type
    });
  }
  return results;
})()`;

// ── browser-use inspired: DOM Bounding Box Annotations ─────────
// Injects numbered badges on interactive elements for sniper-precision clicking
// The vision model sees the numbers on the screenshot and references them by ID

const ANNOTATE_ELEMENTS_JS = `
(function() {
  // Remove previous annotations
  document.querySelectorAll('.lobster-bbox-label').forEach(function(el) { el.remove(); });
  window.__lobsterElementMap = [];

  var selectors = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [onclick], [tabindex]:not([tabindex="-1"]), img[alt], video, [contenteditable="true"], h3 a, [data-href], summary, [data-control-name], .artdeco-button, .msg-form__contenteditable, [contenteditable="true"], .entity-result__title-text a';
  var elements = document.querySelectorAll(selectors);
  var results = [];
  var id = 0;

  for (var i = 0; i < elements.length && id < 80; i++) {
    var el = elements[i];
    var rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
    if (rect.right < 0 || rect.left > window.innerWidth) continue;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.1) continue;

    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute('role') || tag;
    var text = (el.textContent || '').trim().replace(/\\s+/g, ' ').substring(0, 50);
    var ariaLabel = el.getAttribute('aria-label') || '';
    var placeholder = el.getAttribute('placeholder') || '';
    var value = (el.value || '').substring(0, 30);
    var type = el.getAttribute('type') || '';
    var href = el.getAttribute('href') || '';

    // Map to 768x768 screenshot grid
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var x768 = Math.round((cx / window.innerWidth) * 768);
    var y768 = Math.round((cy / window.innerHeight) * 768);

    var label = ariaLabel || text || placeholder || value || (tag + (type ? '[' + type + ']' : ''));

    // Create visual badge overlay
    var badge = document.createElement('div');
    badge.className = 'lobster-bbox-label';
    badge.textContent = id;
    badge.style.cssText = 'position:fixed;z-index:999990;pointer-events:none;'
      + 'left:' + Math.max(0, rect.left - 2) + 'px;'
      + 'top:' + Math.max(0, rect.top - 14) + 'px;'
      + 'background:rgba(255,43,68,0.92);color:#fff;'
      + 'font-size:10px;font-weight:700;font-family:monospace;'
      + 'padding:1px 4px;border-radius:4px;line-height:13px;'
      + 'box-shadow:0 1px 3px rgba(0,0,0,0.5);'
      + 'min-width:14px;text-align:center;';
    document.body.appendChild(badge);

    // Also draw a subtle border around the element
    var outline = document.createElement('div');
    outline.className = 'lobster-bbox-label';
    outline.style.cssText = 'position:fixed;z-index:999989;pointer-events:none;'
      + 'left:' + rect.left + 'px;top:' + rect.top + 'px;'
      + 'width:' + rect.width + 'px;height:' + rect.height + 'px;'
      + 'border:1.5px solid rgba(255,43,68,0.55);border-radius:3px;'
      + 'background:rgba(255,43,68,0.04);';
    document.body.appendChild(outline);

    results.push({
      id: id,
      tag: tag, role: role, type: type,
      label: label.substring(0, 60),
      href: href.substring(0, 80),
      x: x768, y: y768,
      cx: Math.round(cx), cy: Math.round(cy),
      w: Math.round(rect.width), h: Math.round(rect.height)
    });

    // Store element reference for direct clicking
    el.setAttribute('data-lobster-id', String(id));
    id++;
  }

  window.__lobsterElementMap = results;
  return results;
})()`;

const CLEAR_ANNOTATIONS_JS = `
(function() {
  document.querySelectorAll('.lobster-bbox-label').forEach(function(el) { el.remove(); });
  window.__lobsterElementMap = [];
})()`;

// Gather element map WITHOUT visual badges — used on user's visible tab to avoid flashing
// Enhanced: captures more text (100 chars), better selectors for search results,
// prioritizes visible links/buttons, includes Google search result titles
const GATHER_ELEMENTS_ONLY_JS = `
(function() {
  window.__lobsterElementMap = [];
  var selectors = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [onclick], [tabindex]:not([tabindex="-1"]), img[alt], video, [contenteditable="true"], h3 a, [data-href], summary, [data-control-name], .artdeco-button, .msg-form__contenteditable, [contenteditable="true"], .entity-result__title-text a';
  var elements = document.querySelectorAll(selectors);
  var results = [];
  var id = 0;
  var seen = new Set();

  for (var i = 0; i < elements.length && id < 150; i++) {
    var el = elements[i];
    if (seen.has(el)) continue;
    seen.add(el);

    var rect = el.getBoundingClientRect();
    if (rect.width < 5 || rect.height < 5) continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
    if (rect.right < 0 || rect.left > window.innerWidth) continue;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.1) continue;

    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute('role') || tag;

    var text = '';
    if (tag === 'a' || tag === 'button') {
      var childTexts = [];
      for (var c = 0; c < el.childNodes.length; c++) {
        var node = el.childNodes[c];
        if (node.nodeType === 3) childTexts.push(node.textContent.trim());
        else if (node.nodeType === 1 && ['SPAN','STRONG','EM','B','I','H3','CITE','DIV'].indexOf(node.tagName) !== -1) {
          childTexts.push((node.textContent || '').trim());
        }
      }
      text = childTexts.join(' ').replace(/\\s+/g, ' ').trim();
      if (!text) text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    } else {
      text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    }
    text = text.substring(0, 100);

    var ariaLabel = el.getAttribute('aria-label') || '';
    var title = el.getAttribute('title') || '';
    var name = el.getAttribute('name') || '';
    var placeholder = el.getAttribute('placeholder') || '';
    var value = (el.value || '').substring(0, 30);
    var type = el.getAttribute('type') || '';
    var href = el.getAttribute('href') || el.getAttribute('data-href') || '';

    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var x768 = Math.round((cx / window.innerWidth) * 768);
    var y768 = Math.round((cy / window.innerHeight) * 768);

    var label = ariaLabel || text || title || placeholder || value || name || (tag + (type ? '[' + type + ']' : ''));
    if (!label || label === tag || label === 'button') {
      var svgTitle = el.querySelector('svg title');
      if (svgTitle) label = (svgTitle.textContent || '').trim();
      if (!label || label === tag || label === 'button') {
        var par = el.closest('[aria-label]');
        if (par && par !== el) label = par.getAttribute('aria-label') || '';
      }
    }
    var section = '';
    var secEl = el.closest('[aria-label], [role="region"], [role="navigation"], nav[aria-label]');
    if (secEl && secEl !== el) section = secEl.getAttribute('aria-label') || '';

    results.push({
      id: id, tag: tag, role: role, type: type,
      label: label.substring(0, 100),
      title: title.substring(0, 60),
      name: name.substring(0, 40),
      section: section.substring(0, 60),
      href: href.substring(0, 120),
      x: x768, y: y768,
      cx: Math.round(cx), cy: Math.round(cy),
      w: Math.round(rect.width), h: Math.round(rect.height)
    });
    el.setAttribute('data-lobster-id', String(id));
    id++;
  }
  window.__lobsterElementMap = results;
  return results;
})()`;

// Click element by its annotation ID — uses DOM click() for reliability on background tabs
const CLICK_ELEMENT_REF_JS = (refId: number) => `
(function() {
  var el = document.querySelector('[data-lobster-id="${refId}"]');
  if (!el) return { found: false, error: 'Element #${refId} not found' };
  // Scroll into view if needed — prevents 0,0 coordinates for offscreen elements
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  // Small delay to let scroll settle, then re-measure
  var rect = el.getBoundingClientRect();
  // If rect is zero-sized, try parent or force layout
  if (rect.width === 0 && rect.height === 0) {
    var parent = el.parentElement;
    if (parent) { rect = parent.getBoundingClientRect(); }
  }
  var cx = Math.round(rect.left + rect.width / 2);
  var cy = Math.round(rect.top + rect.height / 2);
  // Sanity: if coords are at 0,0 or negative, element is hidden
  if (cx <= 0 && cy <= 0) return { found: false, error: 'Element #${refId} has no visible position (hidden/collapsed)' };
  // Focus the element first (helps with contentEditable and inputs)
  try { el.focus(); } catch(e) {}
  return { found: true, x: cx, y: cy, tag: el.tagName, text: (el.textContent || '').trim().substring(0, 40) };
})()`;

const DISMISS_COOKIES_JS = `
(function() {
  var ids = ['onetrust-accept-btn-handler', 'accept-all-cookies',
    'CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    'didomi-notice-agree-button', 'cookie-accept', 'cookieAccept',
    'L2AGLb', 'W0wltc'];
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById(ids[i]);
    if (el) { el.click(); return 'clicked #' + ids[i]; }
  }
  var selectors = ['.cookie-consent-accept', '.accept-cookies',
    '[data-testid*="accept"]', '[data-action="accept"]',
    '.cc-accept', '.cc-dismiss', '.js-cookie-accept',
    'button[jsname="b3VHJd"]', 'form[action*="consent"] button:last-child',
    '.fc-cta-consent', '.fc-primary-button', '#consent-page .primary',
    '.qc-cmp2-summary-buttons button:last-child',
    '.evidon-banner-acceptbutton', '#truste-consent-button',
    '.message-component.privacy-manager-tcfv2 .accept-all',
    '[class*="cookie"] [class*="accept"]', '[class*="cookie"] [class*="agree"]',
    '[id*="cookie"] button:first-child',
    '.sp_choice_type_11', '.ncoi-consent__btn'];
  for (var i = 0; i < selectors.length; i++) {
    try {
      var el = document.querySelector(selectors[i]);
      if (el) { el.click(); return 'clicked ' + selectors[i]; }
    } catch(e) {}
  }
  var acceptWords = ['accept all','accept all cookies','accept','agree','i agree',
    'got it','allow all','allow all cookies','agree and continue','consent',
    'zaakceptuj wszystko','zaakceptuj','akceptuj','akceptuj wszystko',
    'alle akzeptieren','akzeptieren','tout accepter','accepter',
    'aceptar todo','aceptar','accetta tutto','accetta'];
  var btns = document.querySelectorAll('button, a[role="button"], [role="button"], div[role="button"]');
  for (var j = 0; j < btns.length; j++) {
    var t = (btns[j].textContent || '').toLowerCase().trim();
    for (var k = 0; k < acceptWords.length; k++) {
      if (t === acceptWords[k] || t.indexOf(acceptWords[k]) !== -1) {
        btns[j].click();
        return 'clicked: ' + t.substring(0,40);
      }
    }
  }
  return 'no cookie banner found';
})()`;

// ── Visual Pincer Overlay ─────────────────────────────────────────
// Inject CSS + JS to show agent actions on the page

const INJECT_OVERLAY_CSS = `
(function() {
  if (document.getElementById('lobster-overlay-css')) return;
  var style = document.createElement('style');
  style.id = 'lobster-overlay-css';
  style.textContent = \`
    @keyframes lobster-ripple {
      0% { transform: translate(-50%, -50%) scale(0); opacity: 1; }
      70% { opacity: 0.5; }
      100% { transform: translate(-50%, -50%) scale(3); opacity: 0; }
    }
    @keyframes lobster-dot-pulse {
      0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 0.9; }
      50% { transform: translate(-50%, -50%) scale(1.3); opacity: 1; }
    }
    @keyframes lobster-fadeout {
      0% { opacity: 1; }
      100% { opacity: 0; }
    }
    /* Persistent animated agent cursor — Lobster aurora style */
    #lobster-agent-cursor {
      position: fixed !important;
      pointer-events: none !important;
      z-index: 2147483647 !important;
      opacity: 0 !important;
      transition: left 0.2s cubic-bezier(0.34, 1.56, 0.64, 1),
                  top 0.2s cubic-bezier(0.34, 1.56, 0.64, 1),
                  opacity 0.15s ease !important;
      filter: drop-shadow(0 0 12px rgba(255, 43, 68, 0.6))
              drop-shadow(0 2px 4px rgba(0,0,0,0.4)) !important;
    }
    #lobster-agent-cursor.visible {
      opacity: 1 !important;
    }
    /* Glow aura behind the cursor */
    #lobster-agent-cursor::before {
      content: '';
      position: absolute;
      width: 32px;
      height: 32px;
      left: -6px;
      top: -6px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(255, 43, 68, 0.35) 0%, rgba(255, 43, 68, 0) 70%);
      animation: lobster-cursor-glow 1.5s ease-in-out infinite;
    }
    @keyframes lobster-cursor-glow {
      0%, 100% { transform: scale(1); opacity: 0.6; }
      50% { transform: scale(1.5); opacity: 1; }
    }
    #lobster-agent-cursor .cursor-label {
      position: absolute;
      left: 24px;
      top: 0px;
      background: linear-gradient(135deg, rgba(255, 43, 68, 0.85) 0%, rgba(180, 13, 17, 0.85) 100%);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: white;
      font-size: 10px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 8px;
      white-space: nowrap;
      box-shadow: 0 2px 16px rgba(255, 43, 68, 0.35), inset 0 1px 0 rgba(255,255,255,0.15);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      letter-spacing: 0.02em;
      opacity: 0;
      transform: translateX(-4px);
      transition: opacity 0.25s ease 0.35s, transform 0.25s ease 0.35s;
      border: 1px solid rgba(255,255,255,0.1);
    }
    #lobster-agent-cursor.visible .cursor-label {
      opacity: 1;
      transform: translateX(0);
    }
    .lobster-click-ripple {
      position: fixed;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      border: 1.5px solid rgba(255, 43, 68, 0.7);
      background: radial-gradient(circle, rgba(255, 43, 68, 0.15) 0%, transparent 70%);
      pointer-events: none;
      z-index: 999999;
      animation: lobster-ripple 0.7s ease-out forwards;
    }
    .lobster-click-ripple::after {
      content: '';
      position: absolute;
      inset: -8px;
      border-radius: 50%;
      border: 1px solid rgba(255, 43, 68, 0.3);
      animation: lobster-ripple 0.9s 0.1s ease-out forwards;
    }
    .lobster-click-dot {
      position: fixed;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: radial-gradient(circle, #ff2b44 0%, rgba(255,43,68,0.5) 100%);
      box-shadow: 0 0 16px rgba(255, 43, 68, 0.5), 0 0 32px rgba(255, 43, 68, 0.2);
      pointer-events: none;
      z-index: 999998;
      animation: lobster-dot-pulse 0.5s ease-in-out, lobster-fadeout 1s 0.3s ease-out forwards;
    }
    .lobster-highlight {
      outline: 2px solid rgba(255, 43, 68, 0.7) !important;
      outline-offset: 2px;
      box-shadow: 0 0 12px rgba(255, 43, 68, 0.3);
      transition: outline 0.2s, box-shadow 0.2s;
    }
    /* Agent activity indicator — pulsing dot top-right */
    #lobster-agent-active {
      position: fixed !important;
      top: 10px !important;
      right: 10px !important;
      width: 14px !important;
      height: 14px !important;
      border-radius: 50% !important;
      background: radial-gradient(circle, #ff4466 0%, #cc1133 100%) !important;
      z-index: 2147483647 !important;
      pointer-events: none !important;
      opacity: 0 !important;
      transition: opacity 0.3s !important;
      box-shadow: 0 0 12px rgba(255, 43, 68, 0.8), 0 0 30px rgba(255, 43, 68, 0.4), 0 0 60px rgba(255, 43, 68, 0.15) !important;
    }
    #lobster-agent-active.active {
      opacity: 1 !important;
      animation: lobster-dot-pulse 0.8s ease-in-out infinite !important;
    }
  \`;
  document.head.appendChild(style);

  // Create agent activity dot
  if (!document.getElementById('lobster-agent-active')) {
    var dot = document.createElement('div');
    dot.id = 'lobster-agent-active';
    document.body.appendChild(dot);
  }

  // Create persistent agent cursor element — beautiful lobster cursor
  if (!document.getElementById('lobster-agent-cursor')) {
    var cursor = document.createElement('div');
    cursor.id = 'lobster-agent-cursor';
    cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none">'
      + '<defs><linearGradient id="lcg" x1="0" y1="0" x2="1" y2="1">'
      + '<stop offset="0%" stop-color="#ff4466"/>'
      + '<stop offset="100%" stop-color="#cc1133"/>'
      + '</linearGradient></defs>'
      + '<path d="M5 3l14 8-6 2-4 6-4-16z" fill="url(#lcg)" stroke="rgba(255,255,255,0.8)" stroke-width="1.2" stroke-linejoin="round"/>'
      + '</svg><span class="cursor-label">Lobster</span>';
    cursor.style.left = '-100px';
    cursor.style.top = '-100px';
    document.body.appendChild(cursor);
  }
})()`;

// Move the persistent agent cursor to position with smooth animation
function buildCursorMoveJS(realX: number, realY: number, label: string): string {
  const safeLabel = JSON.stringify(label);
  return `
    (function() {
      var cursor = document.getElementById('lobster-agent-cursor');
      if (!cursor) return;
      // Drop a trail dot at current position
      if (cursor.classList.contains('visible')) {
        var trail = document.createElement('div');
        trail.className = 'cursor-trail';
        trail.style.position = 'fixed';
        trail.style.left = cursor.style.left;
        trail.style.top = cursor.style.top;
        trail.style.width = '6px';
        trail.style.height = '6px';
        trail.style.borderRadius = '50%';
        trail.style.background = 'rgba(255, 43, 68, 0.3)';
        trail.style.pointerEvents = 'none';
        trail.style.zIndex = '999995';
        trail.style.animation = 'lobster-fadeout 0.5s ease-out forwards';
        document.body.appendChild(trail);
        setTimeout(function() { trail.remove(); }, 500);
      }
      // Update label
      var labelEl = cursor.querySelector('.cursor-label');
      if (labelEl) labelEl.textContent = ${safeLabel};
      // Move cursor smoothly
      cursor.style.left = ${realX} + 'px';
      cursor.style.top = ${realY} + 'px';
      cursor.classList.add('visible');
    })()`;
}

// Show click effect (ripple + dot) at position
function buildClickEffectJS(realX: number, realY: number): string {
  return `
    (function() {
      var x = ${realX}, y = ${realY};
      // Ripple
      var ripple = document.createElement('div');
      ripple.className = 'lobster-click-ripple';
      ripple.style.left = x + 'px';
      ripple.style.top = y + 'px';
      document.body.appendChild(ripple);
      // Dot
      var dot = document.createElement('div');
      dot.className = 'lobster-click-dot';
      dot.style.left = x + 'px';
      dot.style.top = y + 'px';
      document.body.appendChild(dot);
      // Highlight element under cursor
      var el = document.elementFromPoint(x, y);
      if (el) {
        el.classList.add('lobster-highlight');
        setTimeout(function() { el.classList.remove('lobster-highlight'); }, 1500);
      }
      // Cleanup ripple + dot
      setTimeout(function() { ripple.remove(); dot.remove(); }, 1200);
    })()`;
}

// Hide cursor after action completes
function buildCursorHideJS(): string {
  return `
    (function() {
      var cursor = document.getElementById('lobster-agent-cursor');
      if (cursor) {
        setTimeout(function() { cursor.classList.remove('visible'); }, 200);
      }
    })()`;
}

// Hide ALL visual cursor elements before screenshot capture (so AI doesn't see its own cursor)
const HIDE_CURSOR_FOR_SS = `(function(){
  var c = document.getElementById('lobster-agent-cursor');
  if(c) c.style.display='none';
  document.querySelectorAll('.cursor-trail,.lobster-click-ripple,.lobster-click-dot,.lobster-highlight').forEach(function(e){e.style.display='none';});
})()`;
const RESTORE_CURSOR_AFTER_SS = `(function(){
  var c = document.getElementById('lobster-agent-cursor');
  if(c) c.style.display='';
  document.querySelectorAll('.cursor-trail,.lobster-click-ripple,.lobster-click-dot,.lobster-highlight').forEach(function(e){e.style.display='';});
})()`;

// Helper: capture a WebContents page with cursor hidden.
// For background agent tabs: use CDP Page.captureScreenshot (works regardless of visibility).
// For active tab: use capturePage() (fast native capture).
async function capturePageClean(wc: Electron.WebContents, tabId?: number): Promise<Electron.NativeImage> {
  try { await wc.executeJavaScript(HIDE_CURSOR_FOR_SS); } catch {}

  const isBackground = tabId !== undefined && tabId !== activeTabId;
  let image: Electron.NativeImage;

  if (isBackground) {
    // Background agent tab: ONLY use CDP — capturePage returns empty on Windows for occluded views
    image = nativeImage.createEmpty();
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      const result = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
      if (result?.data) {
        image = nativeImage.createFromBuffer(Buffer.from(result.data, 'base64'));
      }
    } catch {
      // CDP failed — try capturePage as last resort (might work if tab is on top)
      image = await wc.capturePage();
    }
  } else {
    // Active/foreground tab: use fast native capturePage
    image = await wc.capturePage();
  }

  wc.executeJavaScript(RESTORE_CURSOR_AFTER_SS).catch(() => {});
  return image;
}

// ── IPC Handlers ────────────────────────────────────────────────────

function setupIPC(): void {
  ipcMain.handle('create-tab', (_e, url: string) => {
    const tab = createTab(url);
    return { id: tab.id, url: tab.url };
  });

  ipcMain.handle('switch-tab', (_e, id: number) => {
    if (!safeTab(id)) return { success: false, error: 'Tab not found or destroyed' };
    switchToTab(id);
    return { success: true };
  });

  ipcMain.handle('close-tab', (_e, id: number) => {
    closeTab(id);
    return { success: true };
  });

  ipcMain.handle('navigate', (_e, url: string) => {
    if (activeTabId === null) {
      createTab(url);
    } else {
      const tab = safeTab(activeTabId);
      if (tab) {
        const fullUrl = url.startsWith('http') ? url : `https://${url}`;
        tab.view.webContents.loadURL(fullUrl);
      }
    }
    return { success: true };
  });

  // Agent-specific navigation: Uses per-task agent tab (multi-tab executor)
  // REUSES existing tab for same taskId — never creates duplicates.
  ipcMain.handle('agent-navigate', (_e, url: string, taskId?: string) => {
    const fullUrl = url.startsWith('http') ? url : `https://${url}`;
    // Multi-tab: check for task-specific tab
    if (taskId) {
      const existingTabId = agentTabs.get(taskId);
      if (existingTabId !== undefined) {
        const tab = tabs.get(existingTabId);
        if (tab && !tab.view.webContents.isDestroyed()) {
          tab.view.webContents.loadURL(fullUrl);
          return { success: true, agentTabId: existingTabId, taskId };
        }
        // Tab was destroyed — remove stale entry
        agentTabs.delete(taskId);
      }
      // Each task gets its own dedicated tab — never reuse another task's tab
      const newTab = createTab(url, false);
      agentTabs.set(taskId, newTab.id);
      agentTabId = newTab.id;
      if (chromeH === 0) updateChromeH(CHROME_H_BROWSING);
      sendToUI('tab-updated', { id: newTab.id, isAgent: true, taskId });
      return { success: true, agentTabId: newTab.id, taskId };
    }
    // Legacy: single agent tab fallback
    if (agentTabId !== null) {
      const tab = tabs.get(agentTabId);
      if (tab && !tab.view.webContents.isDestroyed()) {
        tab.view.webContents.loadURL(fullUrl);
        return { success: true, agentTabId };
      }
    }
    const newTab = createTab(url, false);
    agentTabId = newTab.id;
    if (chromeH === 0) updateChromeH(CHROME_H_BROWSING);
    return { success: true, agentTabId: newTab.id };
  });

  // Agent creates a new tab (per-task or legacy)
  // Tries to reuse existing agent tab — only creates new tab if truly needed
  ipcMain.handle('agent-create-tab', (_e, url: string, taskId?: string) => {
    if (taskId) {
      // Try reusing existing tab for this task
      const existingTabId = agentTabs.get(taskId);
      if (existingTabId !== undefined) {
        const existing = tabs.get(existingTabId);
        if (existing && !existing.view.webContents.isDestroyed()) {
          // Reuse: just navigate to new URL
          const fullUrl = url.startsWith('http') ? url : (url ? `https://${url}` : 'about:blank');
          existing.view.webContents.loadURL(fullUrl);
          return { id: existingTabId, url: existing.url, taskId };
        }
        agentTabs.delete(taskId);
      }
      const newTab = createTab(url, false);
      agentTabs.set(taskId, newTab.id);
      agentTabId = newTab.id;
      if (chromeH === 0) updateChromeH(CHROME_H_BROWSING);
      sendToUI('tab-updated', { id: newTab.id, isAgent: true, taskId });
      return { id: newTab.id, url: newTab.url, taskId };
    }
    // Legacy — reuse if possible
    if (agentTabId !== null) {
      const existing = tabs.get(agentTabId);
      if (existing && !existing.view.webContents.isDestroyed()) {
        const fullUrl = url.startsWith('http') ? url : (url ? `https://${url}` : 'about:blank');
        existing.view.webContents.loadURL(fullUrl);
        return { id: agentTabId, url: existing.url };
      }
      agentTabId = null;
    }
    const newTab = createTab(url, false);
    agentTabId = newTab.id;
    if (chromeH === 0) updateChromeH(CHROME_H_BROWSING);
    return { id: newTab.id, url: newTab.url };
  });

  // Agent closes its tab (per-task or legacy)
  ipcMain.handle('agent-close-tab', (_e, taskId?: string) => {
    if (taskId) {
      const tabId = agentTabs.get(taskId);
      if (tabId !== undefined && tabId !== activeTabId) {
        closeTab(tabId);
        agentTabs.delete(taskId);
        if (agentTabId === tabId) agentTabId = null;
      }
      return { success: true };
    }
    if (agentTabId !== null && agentTabId !== activeTabId) {
      closeTab(agentTabId);
      agentTabId = null;
    }
    return { success: true };
  });

  // Peek at ghost tab — temporarily show it to user
  ipcMain.handle('peek-ghost-tab', () => {
    if (ghostTabId !== null && activeTabId !== ghostTabId) {
      // Move ghost tab to visible position
      const tab = tabs.get(ghostTabId);
      if (tab) {
        tab.view.setBounds(getContentBounds());
        tab.view.setVisible(true);
        // Bring to front (above other tabs, below mainWebView)
        if (rootView) {
          rootView.removeChildView(tab.view);
          rootView.addChildView(tab.view);
          // Re-add mainWebView on top
          rootView.removeChildView(mainWebView!);
          rootView.addChildView(mainWebView!);
        }
        return { success: true, peeking: true };
      }
    }
    return { success: false };
  });

  // Un-peek: hide ghost tab again
  ipcMain.handle('unpeek-ghost-tab', () => {
    if (ghostTabId !== null) {
      const tab = tabs.get(ghostTabId);
      if (tab) {
        // Restore z-order: ghost tab behind everything
        tab.view.setBounds(getContentBounds());
        ensureZOrder();
        return { success: true };
      }
    }
    return { success: false };
  });

  // Reset agent tab (e.g., when user wants agent to work on current tab)
  ipcMain.handle('reset-agent-tab', () => {
    agentTabId = null;
    return { success: true };
  });

  // ── Incognito without AI — toggle private mode for a tab ──
  ipcMain.handle('toggle-private-tab', (_e, tabId: number) => {
    if (privateTabIds.has(tabId)) {
      privateTabIds.delete(tabId);
      sendToUI('tab-updated', { id: tabId, isPrivate: false });
      return { success: true, isPrivate: false };
    } else {
      privateTabIds.add(tabId);
      sendToUI('tab-updated', { id: tabId, isPrivate: true });
      return { success: true, isPrivate: true };
    }
  });
  ipcMain.handle('is-private-tab', (_e, tabId: number) => {
    return privateTabIds.has(tabId);
  });

  // ── Split View ──
  ipcMain.handle('set-split-tab', (_e, tabId: number | null) => {
    splitTabId = tabId;
    // Refresh layout
    if (activeTabId !== null) switchToTab(activeTabId);
    sendToUI('split-view-changed', { splitTabId: tabId });
    return { success: true, splitTabId: tabId };
  });
  ipcMain.handle('get-split-tab', () => {
    return splitTabId;
  });

  // ── Focus Mode ──
  let focusMode = false;
  ipcMain.handle('toggle-focus-mode', () => {
    focusMode = !focusMode;
    if (focusMode) {
      // Focus mode: shrink mainWebView to small overlay at bottom-right
      if (mainWebView && mainWindow) {
        const [w, h] = mainWindow.getContentSize();
        mainWebView.setBounds({ x: w - 100, y: h - 100, width: 100, height: 100 });
        mainWebView.setBackgroundColor('#00000000');
        // Expand active tab to full window (focus mode only exception to bounds rule)
        if (activeTabId !== null) {
          const tab = tabs.get(activeTabId);
          if (tab) {
            tab.view.setBounds({ x: 0, y: 0, width: w, height: h });
            tab.view.setVisible(true);
          }
        }
        ensureZOrder();
      }
    } else {
      // Exit focus mode: restore normal layout
      if (mainWebView) mainWebView.setBackgroundColor('#050505');
      updateChromeH(CHROME_H_BROWSING);
    }
    sendToUI('focus-mode-changed', focusMode);
    return { success: true, focusMode };
  });

  ipcMain.handle('capture-screenshot', async () => {
    const buf = await captureActiveTab();
    return buf ? buf.toString('base64') : null;
  });

  // Capture screenshot for a SPECIFIC agent task tab
  ipcMain.handle('capture-task-screenshot', async (_e, taskId: string) => {
    if (!taskId) return null;
    // Try per-task tab first, fallback to agentTabId, then activeTabId
    const tabId = agentTabs.get(taskId) ?? agentTabId ?? activeTabId;
    if (tabId === null || tabId === undefined) return null;
    const tab = tabs.get(tabId);
    if (!tab || tab.view.webContents.isDestroyed()) return null;
    try {
      const wc = tab.view.webContents;
      const elementMap = await wc.executeJavaScript(GATHER_ELEMENTS_ONLY_JS);
      const image = await capturePageClean(wc, tabId);
      if (image && !image.isEmpty()) {
        const nat = image.getSize();
        const sc = 768 / Math.max(nat.width, nat.height, 1);
        const resized = image.resize({ width: Math.round(nat.width * sc), height: Math.round(nat.height * sc) });
        const buf = resized.toJPEG(85);
        const dims = resized.getSize();
        // Send per-task screenshot via IPC so frontend can forward to backend
        mainWindow?.webContents?.send('screenshot-captured', buf.toString('base64'), elementMap, taskId, { width: dims.width, height: dims.height });
        return buf.toString('base64');
      }
    } catch {}
    return null;
  });

  // get-asset-path is registered in app.on('ready') before createWindow()

  // ── Gallery Tab ──
  let galleryTabId: number | null = null;

  ipcMain.handle('open-gallery-tab', async () => {
    // Reuse existing gallery tab if it exists
    if (galleryTabId !== null) {
      const existing = tabs.get(galleryTabId);
      if (existing && !existing.view.webContents.isDestroyed()) {
        switchToTab(galleryTabId);
        return { id: galleryTabId };
      }
      galleryTabId = null;
    }
    // Create new gallery tab with inline HTML
    const tab = createTab('about:blank');
    if (tab) {
      galleryTabId = tab.id;
      // Send gallery HTML to the frontend — it will be loaded after tab creation
      const galleryHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Lobster Gallery</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Italiana&display=swap');
body{background:#030305;color:#fff;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;min-height:100vh;position:relative;overflow-x:hidden}
.aurora{position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden}
.aurora-orb{position:absolute;border-radius:50%;filter:blur(80px);opacity:0;animation:orb-drift 20s ease-in-out infinite}
.aurora-orb:nth-child(1){width:600px;height:600px;background:radial-gradient(circle,rgba(183,13,17,0.15),transparent 70%);top:-10%;left:10%;animation-delay:0s;animation-duration:18s}
.aurora-orb:nth-child(2){width:500px;height:500px;background:radial-gradient(circle,rgba(255,43,68,0.1),transparent 70%);top:30%;right:-5%;animation-delay:-6s;animation-duration:22s}
.aurora-orb:nth-child(3){width:700px;height:700px;background:radial-gradient(circle,rgba(120,0,60,0.08),transparent 70%);bottom:-15%;left:30%;animation-delay:-12s;animation-duration:25s}
.aurora-orb:nth-child(4){width:400px;height:400px;background:radial-gradient(circle,rgba(255,80,100,0.06),transparent 70%);top:60%;left:-10%;animation-delay:-4s;animation-duration:20s}
@keyframes orb-drift{0%{opacity:0.4;transform:translate(0,0) scale(1)}25%{opacity:0.8;transform:translate(40px,-30px) scale(1.1)}50%{opacity:0.5;transform:translate(-20px,50px) scale(0.95)}75%{opacity:0.9;transform:translate(30px,20px) scale(1.05)}100%{opacity:0.4;transform:translate(0,0) scale(1)}}
body::after{content:'';position:fixed;inset:0;opacity:0.025;pointer-events:none;z-index:1;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
.header{position:sticky;top:0;z-index:10;padding:24px 40px;display:flex;align-items:center;gap:16px;border-bottom:1px solid rgba(255,255,255,0.04);backdrop-filter:blur(24px) saturate(1.4);-webkit-backdrop-filter:blur(24px) saturate(1.4);background:rgba(6,6,10,0.6)}
.header-logo{display:flex;align-items:center;gap:12px}
.header-logo svg{width:28px;height:28px;filter:drop-shadow(0 0 8px rgba(255,43,68,0.3))}
.header h1{font-family:'Italiana',serif;font-size:24px;font-weight:400;background:linear-gradient(135deg,#FF2B44 0%,#ff8090 40%,#FF2B44 80%,#B70D11 100%);background-size:200% 200%;-webkit-background-clip:text;-webkit-text-fill-color:transparent;animation:gradient-shift 6s ease-in-out infinite;letter-spacing:0.02em}
@keyframes gradient-shift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
.header .subtitle{color:rgba(255,255,255,0.2);font-size:11px;font-weight:400;letter-spacing:0.06em;text-transform:uppercase;margin-left:4px}
.header .count{color:rgba(255,255,255,0.3);font-size:11px;padding:4px 12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:20px;font-weight:500;margin-left:auto;backdrop-filter:blur(8px);letter-spacing:0.02em;transition:all 0.3s ease}
.header .count:hover{background:rgba(255,43,68,0.08);border-color:rgba(255,43,68,0.15);color:rgba(255,255,255,0.5)}
.grid{position:relative;z-index:2;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:24px;padding:32px 40px}
.card{background:rgba(255,255,255,0.02);backdrop-filter:blur(16px) saturate(1.2);-webkit-backdrop-filter:blur(16px) saturate(1.2);border:1px solid rgba(255,255,255,0.05);border-radius:16px;overflow:hidden;transition:all 0.4s cubic-bezier(0.16,1,0.3,1);cursor:pointer;opacity:0;animation:card-enter 0.7s cubic-bezier(0.16,1,0.3,1) forwards}
.card:hover{transform:translateY(-6px) scale(1.01);box-shadow:0 20px 60px rgba(183,13,17,0.2),0 0 0 1px rgba(255,43,68,0.12),0 0 80px rgba(255,43,68,0.05);border-color:rgba(255,43,68,0.2)}
.card:active{transform:translateY(-2px) scale(0.99)}
.card .img-wrap{position:relative;overflow:hidden;aspect-ratio:1;background:rgba(12,12,16,0.8)}
.card .img-wrap img{width:100%;height:100%;object-fit:cover;display:block;transition:transform 0.6s cubic-bezier(0.16,1,0.3,1)}
.card:hover .img-wrap img{transform:scale(1.05)}
.card .img-wrap .overlay{position:absolute;inset:0;background:linear-gradient(180deg,transparent 50%,rgba(0,0,0,0.6) 100%);opacity:0;transition:opacity 0.3s ease;display:flex;align-items:flex-end;justify-content:center;padding:16px}
.card:hover .img-wrap .overlay{opacity:1}
.card .img-wrap .overlay .dl-btn{padding:6px 16px;background:rgba(255,255,255,0.15);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.2);border-radius:20px;color:#fff;font-size:11px;font-weight:500;letter-spacing:0.04em;cursor:pointer;transition:all 0.2s ease;display:flex;align-items:center;gap:6px}
.card .img-wrap .overlay .dl-btn:hover{background:rgba(255,43,68,0.3);border-color:rgba(255,43,68,0.4)}
.card .info{padding:14px 16px;background:linear-gradient(180deg,rgba(8,8,12,0.3) 0%,rgba(8,8,12,0.5) 100%)}
.card .prompt{color:rgba(255,255,255,0.45);font-size:11.5px;line-height:1.55;max-height:54px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;font-weight:400}
.card .meta{display:flex;align-items:center;justify-content:space-between;margin-top:8px}
.card .time{color:rgba(255,255,255,0.15);font-size:10px;font-weight:500;letter-spacing:0.03em}
.card .badge{color:rgba(255,43,68,0.5);font-size:9px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;padding:2px 8px;background:rgba(255,43,68,0.06);border-radius:8px}
@keyframes card-enter{from{opacity:0;transform:translateY(20px) scale(0.95)}to{opacity:1;transform:translateY(0) scale(1)}}
.generating .gen-inner{aspect-ratio:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:linear-gradient(135deg,rgba(12,12,16,0.95),rgba(20,14,18,0.9));position:relative;overflow:hidden}
.generating .gen-inner::before{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent 0%,rgba(255,43,68,0.05) 50%,transparent 100%);animation:gen-shimmer 2.5s ease-in-out infinite}
.generating .gen-inner::after{content:'';position:absolute;inset:0;background:radial-gradient(circle at 50% 50%,rgba(255,43,68,0.04),transparent 60%);animation:gen-pulse 3s ease-in-out infinite}
.gen-spinner{width:32px;height:32px;border:2px solid rgba(255,255,255,0.06);border-top-color:rgba(255,43,68,0.5);border-radius:50%;animation:spin 1s linear infinite;z-index:1}
.gen-text{color:rgba(255,255,255,0.2);font-size:11px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;z-index:1}
@keyframes gen-shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
@keyframes gen-pulse{0%,100%{opacity:0.5}50%{opacity:1}}
@keyframes spin{to{transform:rotate(360deg)}}
.empty{text-align:center;padding:120px 32px;grid-column:1/-1}
.empty-icon{width:64px;height:64px;margin:0 auto 20px;opacity:0.08}
.empty-title{color:rgba(255,255,255,0.15);font-size:16px;font-weight:500;margin-bottom:8px;letter-spacing:-0.01em}
.empty-sub{color:rgba(255,255,255,0.08);font-size:12px;font-weight:400;letter-spacing:0.02em}
.lightbox{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,0.85);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);display:none;align-items:center;justify-content:center;opacity:0;transition:opacity 0.3s ease;cursor:zoom-out}
.lightbox.active{display:flex;opacity:1}
.lightbox img{max-width:85vw;max-height:85vh;border-radius:12px;box-shadow:0 16px 80px rgba(0,0,0,0.5);transition:transform 0.4s cubic-bezier(0.16,1,0.3,1)}
.lightbox .close{position:absolute;top:24px;right:24px;width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:center;cursor:pointer;color:rgba(255,255,255,0.5);font-size:18px;transition:all 0.2s ease;backdrop-filter:blur(12px)}
.lightbox .close:hover{background:rgba(255,43,68,0.2);border-color:rgba(255,43,68,0.3);color:#fff}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.06);border-radius:3px}::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.12)}
</style></head><body>
<div class="aurora"><div class="aurora-orb"></div><div class="aurora-orb"></div><div class="aurora-orb"></div><div class="aurora-orb"></div></div>
<div class="header">
  <div class="header-logo">
    <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="52" r="28" fill="#B70D11" opacity="0.9"/><ellipse cx="50" cy="50" rx="26" ry="24" fill="#FF2B44"/>
      <circle cx="40" cy="46" r="4" fill="#fff"/><circle cx="60" cy="46" r="4" fill="#fff"/>
      <circle cx="41" cy="46" r="2" fill="#1a1a2e"/><circle cx="61" cy="46" r="2" fill="#1a1a2e"/>
      <path d="M38 58 Q50 66 62 58" stroke="#fff" stroke-width="2.5" stroke-linecap="round" fill="none"/>
      <path d="M30 30 Q26 18 20 22" stroke="#FF2B44" stroke-width="3" stroke-linecap="round" fill="none"/>
      <path d="M70 30 Q74 18 80 22" stroke="#FF2B44" stroke-width="3" stroke-linecap="round" fill="none"/>
      <path d="M24 56 L10 62 L12 58 L8 54" stroke="#FF2B44" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <path d="M76 56 L90 62 L88 58 L92 54" stroke="#FF2B44" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </svg>
    <div><h1>Gallery</h1><span class="subtitle">AI-Generated Creations</span></div>
  </div>
  <span class="count" id="count">0 images</span>
</div>
<div class="grid" id="grid">
  <div class="empty" id="empty">
    <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
    <div class="empty-title">No images yet</div>
    <div class="empty-sub">Ask Lobster to generate or create images — they'll appear here</div>
  </div>
</div>
<div class="lightbox" id="lightbox" onclick="this.classList.remove('active')">
  <img id="lb-img" src="" alt="">
  <div class="close" onclick="event.stopPropagation();document.getElementById('lightbox').classList.remove('active')">&times;</div>
</div>
<script>
window._images=[];var _cardIndex=0;
window.addImage=function(data){window._images.push(data);document.getElementById('empty')?.remove();var grid=document.getElementById('grid');var card=document.createElement('div');card.className='card';card.style.animationDelay='0.05s';var idx=window._images.length;var promptText=(data.prompt||'').replace(/</g,'&lt;').substring(0,140);var timeStr=new Date(data.ts||Date.now()).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});card.innerHTML='<div class="img-wrap"><img src="'+data.src+'" alt="Generated"><div class="overlay"><div class="dl-btn" onclick="event.stopPropagation();downloadImg('+(idx-1)+')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Save</div></div></div><div class="info"><div class="prompt">'+promptText+'</div><div class="meta"><span class="time">'+timeStr+'</span><span class="badge">AI Generated</span></div></div>';card.onclick=function(){openLightbox(data.src)};grid.insertBefore(card,grid.firstChild);document.getElementById('count').textContent=window._images.length+' image'+(window._images.length!==1?'s':'')};
window.showGenerating=function(){var grid=document.getElementById('grid');document.getElementById('empty')?.remove();var ph=document.createElement('div');ph.className='card generating';ph.id='generating-placeholder';ph.style.opacity='1';ph.innerHTML='<div class="gen-inner"><div class="gen-spinner"></div><div class="gen-text">Creating...</div></div>';grid.insertBefore(ph,grid.firstChild)};
window.hideGenerating=function(){var ph=document.getElementById('generating-placeholder');if(ph)ph.remove()};
function openLightbox(src){var lb=document.getElementById('lightbox');document.getElementById('lb-img').src=src;lb.classList.add('active')}
function downloadImg(idx){var img=window._images[idx];if(!img)return;var a=document.createElement('a');a.href=img.src;a.download='lobster-'+Date.now()+'.png';a.click()}
document.addEventListener('keydown',function(e){if(e.key==='Escape')document.getElementById('lightbox').classList.remove('active')});
</script></body></html>`;
      // Load inline HTML
      const tabObj = tabs.get(galleryTabId);
      if (tabObj && !tabObj.view.webContents.isDestroyed()) {
        tabObj.view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(galleryHtml)}`);
      }
      return { id: galleryTabId };
    }
    return { id: -1 };
  });

  ipcMain.handle('execute-on-gallery', async (_e, code: string) => {
    if (galleryTabId === null) return null;
    const tab = tabs.get(galleryTabId);
    if (!tab || tab.view.webContents.isDestroyed()) {
      galleryTabId = null;
      return null;
    }
    try {
      const result = await tab.view.webContents.executeJavaScript(code);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (e) {
      console.log('[gallery] executeJS error:', e);
      return null;
    }
  });

  // ── Action Guardrails: Dangerous action confirmation ──
  const DANGEROUS_PATTERNS = /pay|checkout|purchase|buy now|delete|remove|logout|sign.?out|unsubscribe|cancel.?subscription|confirm.?payment|place.?order|submit.?payment/i;
  const DANGEROUS_URL_PATTERNS = /checkout|payment|billing|order|cart\/confirm/i;
  const pendingConfirmations = new Map<string, { resolve: (allowed: boolean) => void }>();
  let confirmRequestId = 0;

  ipcMain.on('confirm-action-response', (_e, requestId: string, allowed: boolean) => {
    const pending = pendingConfirmations.get(requestId);
    if (pending) {
      pending.resolve(allowed);
      pendingConfirmations.delete(requestId);
    }
  });

  async function checkGuardrail(actionDesc: string, url: string): Promise<boolean> {
    const textDangerous = DANGEROUS_PATTERNS.test(actionDesc);
    const urlDangerous = DANGEROUS_URL_PATTERNS.test(url);
    if (!textDangerous && !urlDangerous) return true; // safe, proceed

    // Ask user for confirmation
    const reqId = `confirm-${++confirmRequestId}`;
    return new Promise<boolean>((resolve) => {
      pendingConfirmations.set(reqId, { resolve });
      sendToUI('confirm-action', {
        action: actionDesc,
        url: url,
        requestId: reqId,
      });
      // Auto-deny after 30s timeout
      setTimeout(() => {
        if (pendingConfirmations.has(reqId)) {
          pendingConfirmations.delete(reqId);
          resolve(false);
        }
      }, 30000);
    });
  }

  ipcMain.handle('execute-action', async (_e, action: {
    type: string;
    x?: number;
    y?: number;
    text?: string;
    direction?: string;
    amount?: number;
    selector?: string;
    taskId?: string;
  }) => {
    // Multi-tab: route to task-specific tab if taskId provided
    let targetTabId: number | null = null;
    if (action.taskId) {
      targetTabId = agentTabs.get(action.taskId) ?? null;
      // Verify tab still exists and is not destroyed
      if (targetTabId !== null) {
        const existingTab = tabs.get(targetTabId);
        if (!existingTab || existingTab.view.webContents.isDestroyed()) {
          agentTabs.delete(action.taskId);
          targetTabId = null;
        }
      }
      // No agent tab for this task yet — ALWAYS create a dedicated tab for task isolation.
      // Each task gets its own tab so parallel tasks don't interfere with each other.
      if (targetTabId === null) {
        if (action.type === 'navigate') {
          const newTab = createTab('', false);
          agentTabs.set(action.taskId, newTab.id);
          targetTabId = newTab.id;
          agentTabId = newTab.id;
          if (chromeH === 0) updateChromeH(CHROME_H_BROWSING);
          sendToUI('tab-updated', { id: newTab.id, isAgent: true, taskId: action.taskId });
        } else {
          // Non-navigate action without a tab: create dedicated tab for this task
          // Clone the current page URL if possible so the task starts where the user is
          const cloneUrl = (agentTabId !== null ? tabs.get(agentTabId)?.url : null)
            || (activeTabId !== null ? tabs.get(activeTabId)?.url : null)
            || 'about:blank';
          const newTab = createTab(cloneUrl, false);
          agentTabs.set(action.taskId!, newTab.id);
          targetTabId = newTab.id;
          agentTabId = newTab.id;
          if (chromeH === 0) updateChromeH(CHROME_H_BROWSING);
          sendToUI('tab-updated', { id: newTab.id, isAgent: true, taskId: action.taskId });
        }
      }
    } else {
      // Legacy: use single agentTabId
      targetTabId = agentTabId ?? activeTabId;
    }
    if (targetTabId === null) return { success: false, error: 'No active tab' };
    // Block agent from accessing private tabs
    if (privateTabIds.has(targetTabId)) return { success: false, error: 'Tab is private — agent access denied' };
    const tab = tabs.get(targetTabId);
    if (!tab) return { success: false, error: 'Tab not found' };
    // Guard against destroyed webContents (prevents "Illegal invocation" and "Cannot read 'send'")
    if (tab.view.webContents.isDestroyed()) {
      // Remove stale tab and agent references
      tabs.delete(targetTabId);
      if (agentTabId === targetTabId) agentTabId = null;
      if (action.taskId) agentTabs.delete(action.taskId);
      return { success: false, error: 'Tab webContents destroyed' };
    }
    // Lock agent tab on first action (legacy)
    if (!action.taskId && agentTabId === null && targetTabId !== activeTabId) agentTabId = targetTabId;

    const wc = tab.view.webContents;
    // Agent tab is now visible (same bounds as user tab) — always use getContentBounds
    const actionBounds = getContentBounds();

    // Ensure webContents has focus for native input events —
    // canvas apps (Excalidraw) check document.hasFocus() and ignore events without it.
    // wc.focus() is programmatic — does NOT visually switch tabs.
    if (targetTabId !== activeTabId) {
      wc.focus();
    }

    // ── Guardrail check for click-by-text on dangerous actions ──
    if (action.type === 'click-by-text' && action.text) {
      const allowed = await checkGuardrail(`Click "${action.text}"`, tab.url);
      if (!allowed) return { success: false, error: 'Action denied by user' };
    }

    try {
    // Re-check destroyed right before use (race condition guard)
    if (wc.isDestroyed()) return { success: false, error: 'Tab destroyed before action' };

    switch (action.type) {
      case 'click':
        if (action.x !== undefined && action.y !== undefined) {
          // Map from 768x768 screenshot space to actual view size
          const scaleX = actionBounds.width / 768;
          const scaleY = (actionBounds.height) / 768;
          const realX = Math.round(action.x * scaleX);
          const realY = Math.round(action.y * scaleY);
          const desc = typeof action.selector === 'string' ? action.selector : 'click';

          // Visual effects — fire and forget (don't block the click)
          wc.executeJavaScript(buildCursorMoveJS(realX, realY, desc)).catch(() => {});
          wc.executeJavaScript(buildClickEffectJS(realX, realY)).catch(() => {});

          // JS click via elementFromPoint — reliable on background tabs
          wc.executeJavaScript(`
            (function() {
              var el = document.elementFromPoint(${realX}, ${realY});
              if (el) el.click();
            })()
          `).catch(() => {});
          // Also sendInputEvent as backup
          wc.sendInputEvent({ type: 'mouseDown', x: realX, y: realY, button: 'left', clickCount: 1 });
          wc.sendInputEvent({ type: 'mouseUp', x: realX, y: realY, button: 'left', clickCount: 1 });

          // Auto-hide cursor after delay (longer for agent actions so user can see)
          const hideDelay = action.taskId ? 2000 : 300;
          setTimeout(() => wc.executeJavaScript(buildCursorHideJS()).catch(() => {}), hideDelay);
          return { success: true, result: `clicked at ${realX},${realY}` };
        }
        break;

      case 'click-by-text':
        if (action.text) {
          const safeText = JSON.stringify(action.text.toLowerCase());
          // Smart text matching: search across ALL interactive + text elements, prefer exact matches
          const elemInfo = await wc.executeJavaScript(`
            (function() {
              var text = ${safeText};
              // Search widely: links, buttons, headings, divs with click handlers, list items
              var all = document.querySelectorAll('a[href], button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], input[type="submit"], input[type="button"], [onclick], [tabindex]:not([tabindex="-1"]), h1, h2, h3, h4, span[class], div[class], li');
              var bestMatch = null;
              var bestScore = 0;
              for (var i = 0; i < all.length; i++) {
                var el = all[i];
                var rect = el.getBoundingClientRect();
                if (rect.width < 5 || rect.height < 5) continue;
                if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
                var style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') continue;

                var elText = (el.textContent || el.value || el.getAttribute('aria-label') || '').toLowerCase().trim().replace(/\\s+/g, ' ');
                if (!elText) continue;

                // Score matching quality
                var score = 0;
                if (elText === text) score = 100; // exact match
                else if (elText.indexOf(text) === 0) score = 90; // starts with
                else if (elText.indexOf(text) !== -1) {
                  // Contains — prefer shorter elements (more specific)
                  score = 80 - Math.min(elText.length / 10, 30);
                }
                // Bonus for links and buttons (more likely what user wants to click)
                var tag = el.tagName.toLowerCase();
                if (tag === 'a') score += 5;
                if (tag === 'button' || el.getAttribute('role') === 'button') score += 3;
                // Bonus for elements with href (actual navigation links)
                if (el.getAttribute('href') && el.getAttribute('href') !== '#') score += 2;

                if (score > bestScore) {
                  bestScore = score;
                  bestMatch = el;
                }
              }
              if (bestMatch) {
                var rect = bestMatch.getBoundingClientRect();
                bestMatch.click();
                // Also follow href for links (some sites intercept click)
                if (bestMatch.tagName === 'A' && bestMatch.href && !bestMatch.href.startsWith('javascript:')) {
                  // Let the click handle it, but set a short backup
                  setTimeout(function() {
                    if (window.location.href === document.URL) {
                      // Click didn't navigate — try direct navigation
                    }
                  }, 500);
                }
                return { found: true, x: Math.round(rect.left + rect.width/2), y: Math.round(rect.top + rect.height/2), text: (bestMatch.textContent || '').trim().substring(0, 40), score: bestScore };
              }
              return { found: false };
            })()
          `);
          if (elemInfo && elemInfo.found) {
            // Visual effects — fire and forget
            wc.executeJavaScript(buildCursorMoveJS(elemInfo.x, elemInfo.y, elemInfo.text)).catch(() => {});
            wc.executeJavaScript(buildClickEffectJS(elemInfo.x, elemInfo.y)).catch(() => {});
            // Also sendInputEvent as backup for stubborn pages
            wc.sendInputEvent({ type: 'mouseDown', x: elemInfo.x, y: elemInfo.y, button: 'left', clickCount: 1 });
            wc.sendInputEvent({ type: 'mouseUp', x: elemInfo.x, y: elemInfo.y, button: 'left', clickCount: 1 });
            setTimeout(() => wc.executeJavaScript(buildCursorHideJS()).catch(() => {}), action.taskId ? 2000 : 300);
            return { success: true, result: `clicked: "${elemInfo.text}"` };
          }
          return { success: false, error: 'Element not found: ' + action.text };
        }
        break;

      case 'type':
        if (action.text) {
          const isAgentAction = !!action.taskId;
          // Move cursor to the focused input field
          const inputPos = await wc.executeJavaScript(`
            (function() {
              var el = document.activeElement;
              if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                var rect = el.getBoundingClientRect();
                return { x: Math.round(rect.left + rect.width/2), y: Math.round(rect.top + rect.height/2) };
              }
              return null;
            })()
          `);
          if (inputPos) {
            wc.executeJavaScript(buildCursorMoveJS(inputPos.x, inputPos.y, 'typing...')).catch(() => {});
          }

          if (isAgentAction) {
            // Ghost Fill: animated character-by-character typing with purple highlight
            const safeGhostText = JSON.stringify(action.text);
            await wc.executeJavaScript(`
              (async function() {
                var el = document.activeElement;
                if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable)) {
                  // First: look for contentEditable elements (LinkedIn message boxes, rich text editors)
                  var editables = document.querySelectorAll('[contenteditable="true"], [role="textbox"]');
                  for (var i = 0; i < editables.length; i++) {
                    var rect = editables[i].getBoundingClientRect();
                    if (rect.width > 50 && rect.height > 20) { el = editables[i]; el.focus(); break; }
                  }
                  // Fallback: standard input/textarea
                  if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable)) {
                    var inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="search"]), textarea');
                    for (var i = 0; i < inputs.length; i++) {
                      var rect = inputs[i].getBoundingClientRect();
                      if (rect.width > 0 && rect.height > 0) { el = inputs[i]; el.focus(); break; }
                    }
                  }
                }
                if (!el) return 'no input found';

                // Red ghost glow (brand color)
                var origOutline = el.style.outline;
                var origShadow = el.style.boxShadow;
                var origTransition = el.style.transition;
                el.style.transition = 'box-shadow 0.3s, outline 0.3s';
                el.style.outline = '2px solid rgba(220, 38, 38, 0.8)';
                el.style.boxShadow = '0 0 20px rgba(220, 38, 38, 0.3), inset 0 0 8px rgba(220, 38, 38, 0.1)';

                var text = ${safeGhostText};
                var tag = el.tagName;
                var delay = text.length > 200 ? 3 : (text.length > 80 ? 5 : 8 + Math.random() * 7);
                var instant = text.length > 300;
                if (el.isContentEditable) {
                  if (instant) {
                    el.textContent = text;
                    el.dispatchEvent(new Event('input', {bubbles: true}));
                  } else {
                    for (var c = 0; c < text.length; c++) {
                      el.textContent = text.substring(0, c + 1);
                      el.dispatchEvent(new Event('input', {bubbles: true}));
                      await new Promise(function(r) { setTimeout(r, delay); });
                    }
                  }
                } else {
                  var proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                  var desc = Object.getOwnPropertyDescriptor(proto, 'value');
                  if (instant) {
                    if (desc && desc.set) desc.set.call(el, text);
                    else el.value = text;
                    el.dispatchEvent(new Event('input', {bubbles: true}));
                  } else {
                    for (var c = 0; c < text.length; c++) {
                      var partial = text.substring(0, c + 1);
                      if (desc && desc.set) desc.set.call(el, partial);
                      else el.value = partial;
                      el.dispatchEvent(new Event('input', {bubbles: true}));
                      await new Promise(function(r) { setTimeout(r, delay); });
                    }
                  }
                  el.dispatchEvent(new Event('change', {bubbles: true}));
                }

                // Fade out ghost glow
                setTimeout(function() {
                  el.style.outline = origOutline || '';
                  el.style.boxShadow = origShadow || '';
                  setTimeout(function() { el.style.transition = origTransition || ''; }, 400);
                }, 1000);

                return 'ghost-filled: ' + text.substring(0, 50);
              })()
            `);
          } else {
            // Instant fill — original behavior
            const safeTypeText = JSON.stringify(action.text);
            await wc.executeJavaScript(`
              (function() {
                var el = document.activeElement;
                if (!el) return 'no active element';
                var tag = el.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) {
                  el.classList.add('lobster-highlight');
                  setTimeout(function() { el.classList.remove('lobster-highlight'); }, 1500);
                  try {
                    if (el.isContentEditable) {
                      el.textContent = ${safeTypeText};
                      el.dispatchEvent(new Event('input', {bubbles: true}));
                      return 'set contentEditable: ' + el.textContent.substring(0, 50);
                    }
                    var proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
                    if (desc && desc.set) {
                      desc.set.call(el, ${safeTypeText});
                    } else {
                      el.value = ${safeTypeText};
                    }
                    el.dispatchEvent(new Event('input', {bubbles: true}));
                    el.dispatchEvent(new Event('change', {bubbles: true}));
                    return 'set value: ' + el.value.substring(0, 50);
                  } catch(e) {
                    try { el.value = ${safeTypeText}; } catch(e2) {}
                    return 'fallback set value';
                  }
                }
                var inputs = document.querySelectorAll('input:not([type="hidden"]), textarea');
                for (var i = 0; i < inputs.length; i++) {
                  var inp = inputs[i];
                  var rect = inp.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0 && window.getComputedStyle(inp).display !== 'none') {
                    inp.focus();
                    inp.value = ${safeTypeText};
                    inp.dispatchEvent(new Event('input', {bubbles: true}));
                    inp.dispatchEvent(new Event('change', {bubbles: true}));
                    return 'found and typed in: ' + inp.tagName;
                  }
                }
                return 'no suitable input found';
              })()
            `);
            // Also send key events for apps that listen to keydown
            for (const char of action.text) {
              wc.sendInputEvent({ type: 'keyDown', keyCode: char });
              wc.sendInputEvent({ type: 'char', keyCode: char });
              wc.sendInputEvent({ type: 'keyUp', keyCode: char });
            }
          }
          await wc.executeJavaScript(buildCursorHideJS()).catch(() => {});
        }
        break;

      case 'scroll':
        await wc.executeJavaScript(
          `window.scrollBy(0, ${action.direction === 'up' ? -(action.amount || 500) : (action.amount || 500)})`
        );
        break;

      case 'enter':
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
        break;

      case 'back':
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        break;

      case 'forward':
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        break;

      case 'extract-text':
        return {
          success: true,
          text: await wc.executeJavaScript('document.body.innerText.substring(0, 5000)')
        };

      case 'get-page-snapshot': {
        const elements = await wc.executeJavaScript(PAGE_SNAPSHOT_JS);
        return { success: true, url: tab.url, title: tab.title, elements };
      }

      case 'drag': {
        // Mouse drag from one point to another — REAL Chromium input events with timing
        const sX1 = actionBounds.width / 768;
        const sY1 = actionBounds.height / 768;
        const fx = Math.round((action.x !== undefined ? action.x : (action as any).from_x || 0) * sX1);
        const fy = Math.round((action.y !== undefined ? action.y : (action as any).from_y || 0) * sY1);
        const tx = Math.round(((action as any).to_x || 0) * sX1);
        const ty = Math.round(((action as any).to_y || 0) * sY1);
        const dragDesc = (action as any).description || 'drag';

        wc.executeJavaScript(buildCursorMoveJS(fx, fy, dragDesc)).catch(() => {});

        // Move to start position first
        wc.sendInputEvent({ type: 'mouseMove', x: fx, y: fy });
        await new Promise(r => setTimeout(r, 30));
        wc.sendInputEvent({ type: 'mouseDown', x: fx, y: fy, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 30));

        // Smooth drag with delays so pages can process each move
        const steps = 20;
        for (let i = 1; i <= steps; i++) {
          const mx = Math.round(fx + (tx - fx) * i / steps);
          const my = Math.round(fy + (ty - fy) * i / steps);
          wc.sendInputEvent({ type: 'mouseMove', x: mx, y: my });
          await new Promise(r => setTimeout(r, 8));
        }
        await new Promise(r => setTimeout(r, 20));
        wc.sendInputEvent({ type: 'mouseUp', x: tx, y: ty, button: 'left', clickCount: 1 });

        setTimeout(() => wc.executeJavaScript(buildCursorHideJS()).catch(() => {}), action.taskId ? 2000 : 300);
        return { success: true, result: `dragged: ${dragDesc}` };
      }

      case 'drag-path': {
        // Draw a complex path through multiple points — REAL Chromium input events with timing
        const sX2 = actionBounds.width / 768;
        const sY2 = actionBounds.height / 768;
        const points: Array<{x: number; y: number}> = (action as any).points || [];
        const pathDesc = (action as any).description || 'draw path';

        if (points.length < 2) return { success: false, error: 'Need at least 2 points' };

        const realPoints = points.map(p => ({
          x: Math.round(p.x * sX2),
          y: Math.round(p.y * sY2),
        }));

        // Cursor visual — show at start
        wc.executeJavaScript(buildCursorMoveJS(realPoints[0].x, realPoints[0].y, pathDesc)).catch(() => {});

        // Move to start position first
        wc.sendInputEvent({ type: 'mouseMove', x: realPoints[0].x, y: realPoints[0].y });
        await new Promise(r => setTimeout(r, 50));
        wc.sendInputEvent({ type: 'mouseDown', x: realPoints[0].x, y: realPoints[0].y, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 50));

        // Interpolate between provided points for smooth visible drawing
        // Use Catmull-Rom spline for smooth curves, then densely sample at ~2px
        const interpolated: Array<{x: number; y: number}> = [realPoints[0]];
        for (let i = 0; i < realPoints.length - 1; i++) {
          const p0 = realPoints[Math.max(0, i - 1)];
          const p1 = realPoints[i];
          const p2 = realPoints[i + 1];
          const p3 = realPoints[Math.min(realPoints.length - 1, i + 2)];
          const dist = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
          const steps = Math.max(2, Math.round(dist / 2)); // ~2px per step for very smooth curves
          for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            const t2 = t * t, t3 = t2 * t;
            // Catmull-Rom spline interpolation (tension=0.5)
            const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
            const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
            interpolated.push({ x: Math.round(x), y: Math.round(y) });
          }
        }

        // Draw with visible timing — move cursor visual along path
        for (let i = 1; i < interpolated.length; i++) {
          wc.sendInputEvent({ type: 'mouseMove', x: interpolated[i].x, y: interpolated[i].y });
          // Update cursor visual every few points
          if (i % 8 === 0) {
            wc.executeJavaScript(`
              (function(){var c=document.getElementById('__pulse_cursor');if(c){c.style.left='${interpolated[i].x}px';c.style.top='${interpolated[i].y}px';}})()
            `).catch(() => {});
          }
          // 6ms delay = fast smooth drawing (~160 points/sec) — canvas apps can handle this
          await new Promise(r => setTimeout(r, 6));
        }

        await new Promise(r => setTimeout(r, 30));
        const last = interpolated[interpolated.length - 1];
        wc.sendInputEvent({ type: 'mouseUp', x: last.x, y: last.y, button: 'left', clickCount: 1 });

        setTimeout(() => wc.executeJavaScript(buildCursorHideJS()).catch(() => {}), 500);
        return { success: true, result: `drew path: ${pathDesc} (${points.length} points, ${interpolated.length} interpolated)` };
      }

      case 'dismiss-cookies': {
        const result = await wc.executeJavaScript(DISMISS_COOKIES_JS);
        return { success: true, result };
      }

      case 'press-key': {
        const key = (action as any).key || '';
        const modifiers: string[] = [];
        if ((action as any).ctrl) modifiers.push('control');
        if ((action as any).shift) modifiers.push('shift');
        if ((action as any).alt) modifiers.push('alt');
        wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers } as any);
        wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers } as any);
        return { success: true, result: `pressed ${modifiers.length ? modifiers.join('+') + '+' : ''}${key}` };
      }

      case 'hover': {
        const hx = Math.round(((action as any).x || 0) * actionBounds.width / 768);
        const hy = Math.round(((action as any).y || 0) * actionBounds.height / 768);
        const hDesc = (action as any).description || 'hover';
        wc.executeJavaScript(buildCursorMoveJS(hx, hy, hDesc)).catch(() => {});
        wc.sendInputEvent({ type: 'mouseMove', x: hx, y: hy });
        // Also dispatch JS hover events for pages that listen to them
        wc.executeJavaScript(`
          (function() {
            var el = document.elementFromPoint(${hx}, ${hy});
            if (el) {
              el.dispatchEvent(new MouseEvent('mouseover', {bubbles: true, clientX: ${hx}, clientY: ${hy}}));
              el.dispatchEvent(new MouseEvent('mouseenter', {bubbles: true, clientX: ${hx}, clientY: ${hy}}));
            }
          })()
        `).catch(() => {});
        setTimeout(() => wc.executeJavaScript(buildCursorHideJS()).catch(() => {}), 1500);
        return { success: true, result: `hovered at ${hx},${hy}: ${hDesc}` };
      }

      case 'double-click': {
        const dx = Math.round(((action as any).x || 0) * actionBounds.width / 768);
        const dy = Math.round(((action as any).y || 0) * actionBounds.height / 768);
        const dDesc = (action as any).description || 'double-click';
        wc.executeJavaScript(buildCursorMoveJS(dx, dy, dDesc)).catch(() => {});
        wc.executeJavaScript(buildClickEffectJS(dx, dy)).catch(() => {});
        wc.sendInputEvent({ type: 'mouseDown', x: dx, y: dy, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: dx, y: dy, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseDown', x: dx, y: dy, button: 'left', clickCount: 2 });
        wc.sendInputEvent({ type: 'mouseUp', x: dx, y: dy, button: 'left', clickCount: 2 });
        setTimeout(() => wc.executeJavaScript(buildCursorHideJS()).catch(() => {}), action.taskId ? 2000 : 300);
        return { success: true, result: `double-clicked at ${dx},${dy}: ${dDesc}` };
      }

      case 'select-option': {
        const safeVal = JSON.stringify(((action as any).value || '').toLowerCase());
        const selResult = await wc.executeJavaScript(`
          (function() {
            var selects = document.querySelectorAll('select');
            for (var s of selects) {
              var rect = s.getBoundingClientRect();
              if (rect.width < 5 || rect.height < 5) continue;
              for (var opt of s.options) {
                if (opt.textContent.trim().toLowerCase().includes(${safeVal}) || opt.value.toLowerCase().includes(${safeVal})) {
                  s.value = opt.value;
                  s.dispatchEvent(new Event('change', {bubbles: true}));
                  s.dispatchEvent(new Event('input', {bubbles: true}));
                  return {found: true, selected: opt.textContent.trim()};
                }
              }
            }
            return {found: false, error: 'No matching option found'};
          })()
        `);
        return { success: selResult?.found || false, result: selResult };
      }

      case 'wait': {
        const condition = (action as any).condition || 'time';
        const ms = Math.min((action as any).milliseconds || 1000, 10000);

        if (condition === 'time') {
          await new Promise(r => setTimeout(r, ms));
          return { success: true, result: `waited ${ms}ms` };
        }
        if (condition === 'text') {
          const safeWaitText = JSON.stringify((action as any).text || '');
          const timeout = ms;
          const start = Date.now();
          while (Date.now() - start < timeout) {
            const found = await wc.executeJavaScript(`document.body.innerText.includes(${safeWaitText})`);
            if (found) return { success: true, result: `text found: ${(action as any).text}` };
            await new Promise(r => setTimeout(r, 300));
          }
          return { success: false, error: `text not found within ${timeout}ms` };
        }
        if (condition === 'url') {
          const timeout = ms;
          const start = Date.now();
          const pattern = (action as any).pattern || '';
          while (Date.now() - start < timeout) {
            if (wc.getURL().includes(pattern)) return { success: true, result: `URL matches: ${pattern}` };
            await new Promise(r => setTimeout(r, 300));
          }
          return { success: false, error: 'URL pattern not matched' };
        }
        return { success: true };
      }

      case 'evaluate': {
        if (wc.isDestroyed()) return { success: false, error: 'Tab destroyed' };
        try {
          // Show activity indicator
          wc.executeJavaScript(`(function(){var d=document.getElementById('lobster-agent-active');if(d)d.classList.add('active');})()`)
            .catch(() => {});
          const evalResult = await wc.executeJavaScript((action as any).code || '');
          // Hide activity indicator after brief delay
          wc.executeJavaScript(`(function(){var d=document.getElementById('lobster-agent-active');if(d)setTimeout(function(){d.classList.remove('active');},800);})()`)
            .catch(() => {});
          return { success: true, result: JSON.stringify(evalResult).substring(0, 15000) };
        } catch (e: any) {
          // Hide on error too
          wc.executeJavaScript(`(function(){var d=document.getElementById('lobster-agent-active');if(d)d.classList.remove('active');})()`)
            .catch(() => {});
          return { success: false, error: (e.message || 'JS eval failed').substring(0, 500) };
        }
      }

      case 'switch-tab': {
        const tabNum = (action as any).tab_number || 1;
        const tabKeys = Array.from(tabs.keys());
        const idx = Math.max(0, Math.min(tabNum - 1, tabKeys.length - 1));
        if (tabKeys.length > 0) {
          const targetId = tabKeys[idx];
          if (action.taskId) {
            // Agent task: DON'T switch user's visible tab — just update agent's working tab
            agentTabs.set(action.taskId, targetId);
            agentTabId = targetId;
            return { success: true, result: `agent now working on tab ${tabNum} (background)` };
          }
          // No taskId = user-initiated or legacy — actually switch
          switchToTab(targetId);
          return { success: true, result: `switched to tab ${tabNum}` };
        }
        return { success: false, error: 'No tabs open' };
      }

      case 'scroll-to-text': {
        const safeScrollText = JSON.stringify((action as any).text || '');
        const scrollResult = await wc.executeJavaScript(`
          (function() {
            var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              if (walker.currentNode.textContent.includes(${safeScrollText})) {
                walker.currentNode.parentElement.scrollIntoView({behavior: 'smooth', block: 'center'});
                return {found: true};
              }
            }
            return {found: false};
          })()
        `);
        return { success: scrollResult?.found || false, result: scrollResult };
      }

      case 'click-by-ref': {
        // Sniper-precision click: use DOM annotation ID to find exact element coordinates
        const refId = (action as any).ref;
        if (refId === undefined || refId === null) return { success: false, error: 'No ref ID provided' };
        const elemInfo = await wc.executeJavaScript(CLICK_ELEMENT_REF_JS(Number(refId)));
        if (!elemInfo || !elemInfo.found) {
          return { success: false, error: `Element #${refId} not found on page` };
        }
        const refDesc = elemInfo.text || `element #${refId}`;
        // Visual effects
        wc.executeJavaScript(buildCursorMoveJS(elemInfo.x, elemInfo.y, refDesc)).catch(() => {});
        wc.executeJavaScript(buildClickEffectJS(elemInfo.x, elemInfo.y)).catch(() => {});
        // Hover first — many SPAs (LinkedIn, etc.) require mouseMove before click
        wc.sendInputEvent({ type: 'mouseMove', x: elemInfo.x, y: elemInfo.y });
        await new Promise(r => setTimeout(r, 50));
        // REAL Chromium click at exact DOM coordinates
        wc.sendInputEvent({ type: 'mouseDown', x: elemInfo.x, y: elemInfo.y, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 30));
        wc.sendInputEvent({ type: 'mouseUp', x: elemInfo.x, y: elemInfo.y, button: 'left', clickCount: 1 });
        // Also DOM click as backup for stubborn elements
        wc.executeJavaScript(`(function(){ var el=document.querySelector('[data-lobster-id="${refId}"]'); if(el){el.click();} })()`).catch(() => {});
        setTimeout(() => wc.executeJavaScript(buildCursorHideJS()).catch(() => {}), action.taskId ? 2000 : 300);
        return { success: true, result: JSON.stringify({found:true, tag:elemInfo.tag, text:refDesc}) };
      }

      case 'copy-to-clipboard': {
        const text = (action as any).text || '';
        clipboard.writeText(text);
        return { success: true, result: `Copied ${text.length} chars to clipboard` };
      }

      case 'read-clipboard': {
        const clipText = clipboard.readText();
        return { success: true, text: clipText, result: `Read ${clipText.length} chars from clipboard` };
      }

      default:
        return { success: false, error: `Unknown action: ${action.type}` };
    }

    // Re-focus user's active tab so they don't lose keyboard focus after agent action
    if (targetTabId !== activeTabId && activeTabId !== null) {
      const userTab = safeTab(activeTabId);
      if (userTab) {
        userTab.view.webContents.focus();
      }
    }

    return { success: true };
    } catch (err: any) {
      // Tab was destroyed mid-action — clean up silently
      if (err?.message?.includes('destroyed') || err?.message?.includes('Illegal invocation')) {
        if (targetTabId !== null) tabs.delete(targetTabId);
        if (action.taskId) agentTabs.delete(action.taskId);
        return { success: false, error: 'Tab destroyed during action' };
      }
      throw err; // Re-throw unexpected errors
    }
  });

  // Window controls (needed because frame: false removes native buttons)
  ipcMain.on('window-minimize', () => mainWindow?.minimize());
  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.on('window-close', () => mainWindow?.close());
  ipcMain.handle('is-maximized', () => mainWindow?.isMaximized() ?? false);

  // Right panel width (task history drawer) — shrinks content area for tabs
  ipcMain.on('set-right-panel-width', (_e, w: number) => {
    rightPanelW = Math.max(0, Math.round(w));
    // Update all visible tab bounds to account for panel
    for (const [tid, t] of tabs) {
      if (splitTabId !== null && tid === splitTabId) {
        t.view.setBounds(getSplitBounds('right'));
      } else if (tid === activeTabId) {
        t.view.setBounds(splitTabId !== null ? getSplitBounds('left') : getContentBounds());
      }
    }
  });

  // Notify renderer when maximize state changes
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('maximize-changed', true);
    sendToUI('maximize-changed', true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('maximize-changed', false);
    sendToUI('maximize-changed', false);
  });

  // Zoom controls — zoom the active tab's webContents
  ipcMain.handle('zoom-in', () => {
    if (activeTabId !== null) {
      const tab = tabs.get(activeTabId);
      if (tab) {
        const current = tab.view.webContents.getZoomFactor();
        const next = Math.min(current + 0.1, 3.0);
        tab.view.webContents.setZoomFactor(next);
        return Math.round(next * 100);
      }
    }
    return 100;
  });
  ipcMain.handle('zoom-out', () => {
    if (activeTabId !== null) {
      const tab = tabs.get(activeTabId);
      if (tab) {
        const current = tab.view.webContents.getZoomFactor();
        const next = Math.max(current - 0.1, 0.3);
        tab.view.webContents.setZoomFactor(next);
        return Math.round(next * 100);
      }
    }
    return 100;
  });
  ipcMain.handle('zoom-reset', () => {
    if (activeTabId !== null) {
      const tab = tabs.get(activeTabId);
      if (tab) {
        tab.view.webContents.setZoomFactor(1.0);
        return 100;
      }
    }
    return 100;
  });
  ipcMain.handle('get-zoom', () => {
    if (activeTabId !== null) {
      const tab = tabs.get(activeTabId);
      if (tab) return Math.round(tab.view.webContents.getZoomFactor() * 100);
    }
    return 100;
  });

  // Downloads tracking
  const recentDownloads: Array<{ filename: string; url: string; state: string; receivedBytes: number; totalBytes: number; savePath: string }> = [];
  mainWindow.webContents.session.on('will-download', (_event, item) => {
    const dl = {
      filename: item.getFilename(),
      url: item.getURL(),
      state: 'progressing' as string,
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      savePath: '',
    };
    recentDownloads.unshift(dl);
    if (recentDownloads.length > 20) recentDownloads.pop();

    item.on('updated', (_e, state) => {
      dl.state = state;
      dl.receivedBytes = item.getReceivedBytes();
      dl.totalBytes = item.getTotalBytes();
      dl.savePath = item.getSavePath();
      sendToUI('download-update', recentDownloads.map(d => ({
        filename: d.filename, state: d.state,
        progress: d.totalBytes > 0 ? Math.round(d.receivedBytes / d.totalBytes * 100) : 0,
      })));
    });
    item.once('done', (_e, state) => {
      dl.state = state;
      dl.receivedBytes = item.getReceivedBytes();
      sendToUI('download-update', recentDownloads.map(d => ({
        filename: d.filename, state: d.state,
        progress: d.totalBytes > 0 ? Math.round(d.receivedBytes / d.totalBytes * 100) : 0,
      })));
    });
  });
  ipcMain.handle('get-downloads', () => recentDownloads.map(d => ({
    filename: d.filename, url: d.url, state: d.state,
    receivedBytes: d.receivedBytes, totalBytes: d.totalBytes,
  })));
  ipcMain.on('open-downloads', () => {
    const { shell } = require('electron');
    const downloadPath = app.getPath('downloads');
    shell.openPath(downloadPath);
  });

  // ── Find in Page ──
  ipcMain.handle('find-in-page', (_e, text: string, options?: { forward?: boolean; findNext?: boolean }) => {
    if (activeTabId !== null) {
      const tab = tabs.get(activeTabId);
      if (tab && text) {
        tab.view.webContents.findInPage(text, {
          forward: options?.forward ?? true,
          findNext: options?.findNext ?? false,
        });
        // Listen for results
        tab.view.webContents.removeAllListeners('found-in-page');
        tab.view.webContents.on('found-in-page', (_ev, result) => {
          sendToUI('find-in-page-result', {
            matches: result.matches || 0,
            activeMatchOrdinal: result.activeMatchOrdinal || 0,
          });
        });
      }
    }
  });
  ipcMain.handle('stop-find-in-page', () => {
    if (activeTabId !== null) {
      const tab = tabs.get(activeTabId);
      if (tab) {
        tab.view.webContents.stopFindInPage('clearSelection');
        tab.view.webContents.removeAllListeners('found-in-page');
      }
    }
  });

  // ── Print ──
  ipcMain.on('print-page', () => {
    if (activeTabId !== null) {
      const tab = tabs.get(activeTabId);
      if (tab) tab.view.webContents.print();
    }
  });

  // JS-based window drag with Windows Aero Snap support
  let dragStart: { cursorX: number; cursorY: number; winX: number; winY: number } | null = null;
  let preDragBounds: Electron.Rectangle | null = null;

  ipcMain.on('window-drag-start', () => {
    if (!mainWindow) return;
    const cursor = screen.getCursorScreenPoint();
    const [winX, winY] = mainWindow.getPosition();
    if (!mainWindow.isMaximized()) {
      const [w, h] = mainWindow.getSize();
      preDragBounds = { x: winX, y: winY, width: w, height: h };
    }
    dragStart = { cursorX: cursor.x, cursorY: cursor.y, winX, winY };
  });

  ipcMain.on('window-drag-move', () => {
    if (!mainWindow || !dragStart) return;
    if (mainWindow.isMaximized()) {
      const [w] = mainWindow.getSize();
      mainWindow.unmaximize();
      const [newW] = mainWindow.getSize();
      const cursor = screen.getCursorScreenPoint();
      dragStart = { cursorX: cursor.x, cursorY: cursor.y, winX: cursor.x - newW * (cursor.x / w), winY: cursor.y - 20 };
    }
    const cursor = screen.getCursorScreenPoint();
    const dx = cursor.x - dragStart.cursorX;
    const dy = cursor.y - dragStart.cursorY;
    mainWindow.setPosition(Math.round(dragStart.winX + dx), Math.round(dragStart.winY + dy));
  });

  ipcMain.on('window-drag-end', () => {
    if (!mainWindow || !dragStart) { dragStart = null; return; }
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { x, y, width, height } = display.workArea;
    const SNAP_ZONE = 8;

    // Snap to top = maximize
    if (cursor.y <= y + SNAP_ZONE) {
      mainWindow.maximize();
    }
    // Snap to left = left half
    else if (cursor.x <= x + SNAP_ZONE) {
      mainWindow.setBounds({ x, y, width: Math.round(width / 2), height });
    }
    // Snap to right = right half
    else if (cursor.x >= x + width - SNAP_ZONE) {
      mainWindow.setBounds({ x: x + Math.round(width / 2), y, width: Math.round(width / 2), height });
    }
    dragStart = null;
  });

  ipcMain.handle('go-back', () => {
    if (activeTabId !== null) {
      const tab = tabs.get(activeTabId);
      if (tab && tab.view.webContents.navigationHistory.canGoBack()) {
        tab.view.webContents.navigationHistory.goBack();
      }
    }
    return { success: true };
  });

  ipcMain.handle('go-forward', () => {
    if (activeTabId !== null) {
      const tab = tabs.get(activeTabId);
      if (tab && tab.view.webContents.navigationHistory.canGoForward()) {
        tab.view.webContents.navigationHistory.goForward();
      }
    }
    return { success: true };
  });

  ipcMain.handle('get-tabs', () => {
    return Array.from(tabs.values()).map(t => ({
      id: t.id, url: t.url, title: t.title, active: t.id === activeTabId
    }));
  });
}

// ── Window creation ─────────────────────────────────────────────────

const createWindow = (): void => {
  // Try to load lobster icon for taskbar
  let appIcon: Electron.NativeImage | undefined;
  try {
    // In development: icon is at project root electron/assets/
    // Try multiple paths to find the icon
    const tryPaths = [
      path.join(__dirname, 'assets', 'lobster-icon.ico'),        // webpack CopyPlugin output
      path.join(__dirname, '..', 'assets', 'lobster-icon.ico'),
      path.join(__dirname, '..', '..', 'assets', 'lobster-icon.ico'),
      path.join(app.getAppPath(), 'assets', 'lobster-icon.ico'),
      path.join(process.cwd(), 'electron', 'assets', 'lobster-icon.ico'),
      path.join(process.cwd(), 'assets', 'lobster-icon.ico'),
    ];
    for (const p of tryPaths) {
      try {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) {
          appIcon = img;
          console.log('[icon] Loaded lobster icon from:', p);
          break;
        }
      } catch { /* try next */ }
    }
  } catch (e) {
    console.log('[icon] Could not load icon:', e);
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    frame: false,           // Completely frameless — full control, no titlebar edge cases
    backgroundColor: '#050505',
    icon: appIcon,
    title: 'Lobster',
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Use a View container for proper input routing on Windows.
  // The default contentView is a WebContentsView — adding child WebContentsViews
  // to it can cause input event routing issues on Windows.
  // Instead: rootView (View) → mainWebView (React UI) + tab views (browser tabs)
  mainWebView = mainWindow.contentView as WebContentsView;
  rootView = new View();
  mainWindow.contentView = rootView;

  // Add React UI as first child (renders in background)
  rootView.addChildView(mainWebView);
  // CRITICAL: opaque background prevents agent tab content bleeding through
  mainWebView.setBackgroundColor('#050505');

  // Initial bounds: idle mode (full screen for React, no tabs yet)
  const [initW, initH] = mainWindow.getContentSize();
  mainWebView.setBounds({ x: 0, y: 0, width: initW, height: initH });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  // Resize all views when window resizes
  mainWindow.on('resize', () => {
    updateChromeH(chromeH); // recalculates bounds for current mode (also calls ensureZOrder)
  });

  // ── Global keyboard shortcut handler ──────────────────────────────
  // Registered on BOTH mainWindow.webContents AND every tab's webContents
  function handleGlobalShortcut(_event: Electron.Event, input: Electron.Input) {
    if (!mainWindow || input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta; // Ctrl on Windows/Linux, Cmd on Mac

    // F12 → toggle DevTools on active tab
    if (input.key === 'F12') {
      if (activeTabId !== null) {
        const tab = tabs.get(activeTabId);
        if (tab) tab.view.webContents.toggleDevTools();
      } else {
        mainWindow.webContents.toggleDevTools();
      }
    }
    // Ctrl+Shift+I → toggle DevTools on active tab
    if (ctrl && input.shift && input.key.toLowerCase() === 'i') {
      if (activeTabId !== null) {
        const tab = tabs.get(activeTabId);
        if (tab) tab.view.webContents.toggleDevTools();
      } else {
        mainWindow.webContents.toggleDevTools();
      }
    }
    // Ctrl+Shift+J → toggle DevTools on React UI (main webview)
    if (ctrl && input.shift && input.key.toLowerCase() === 'j') {
      mainWindow.webContents.toggleDevTools();
    }

    // ── Tab management shortcuts ──
    // Ctrl+T → New tab
    if (ctrl && !input.shift && input.key.toLowerCase() === 't') {
      createTab('');
    }
    // Ctrl+W → Close active tab
    if (ctrl && !input.shift && input.key.toLowerCase() === 'w') {
      if (activeTabId !== null) closeTab(activeTabId);
    }
    // Ctrl+Tab → Next tab
    if (ctrl && !input.shift && input.key === 'Tab') {
      const tabKeys = getUserTabKeys();
      if (tabKeys.length > 1 && activeTabId !== null) {
        const idx = tabKeys.indexOf(activeTabId);
        switchToTab(tabKeys[(idx + 1) % tabKeys.length]);
      }
    }
    // Ctrl+Shift+Tab → Previous tab
    if (ctrl && input.shift && input.key === 'Tab') {
      const tabKeys = getUserTabKeys();
      if (tabKeys.length > 1 && activeTabId !== null) {
        const idx = tabKeys.indexOf(activeTabId);
        switchToTab(tabKeys[(idx - 1 + tabKeys.length) % tabKeys.length]);
      }
    }
    // Ctrl+1-9 → Switch to tab N
    if (ctrl && !input.shift && input.key >= '1' && input.key <= '9') {
      const tabKeys = getUserTabKeys();
      const idx = parseInt(input.key) - 1;
      if (idx < tabKeys.length) switchToTab(tabKeys[idx]);
    }

    // ── Navigation shortcuts ──
    // Ctrl+L → Focus URL bar
    if (ctrl && !input.shift && input.key.toLowerCase() === 'l') {
      sendToUI('focus-url-bar');
    }
    // Alt+Left → Back
    if (input.alt && !ctrl && input.key === 'ArrowLeft') {
      if (activeTabId !== null) {
        const tab = tabs.get(activeTabId);
        if (tab && tab.view.webContents.navigationHistory.canGoBack()) {
          tab.view.webContents.navigationHistory.goBack();
        }
      }
    }
    // Alt+Right → Forward
    if (input.alt && !ctrl && input.key === 'ArrowRight') {
      if (activeTabId !== null) {
        const tab = tabs.get(activeTabId);
        if (tab && tab.view.webContents.navigationHistory.canGoForward()) {
          tab.view.webContents.navigationHistory.goForward();
        }
      }
    }
    // Ctrl+R or F5 → Reload
    if ((ctrl && !input.shift && input.key.toLowerCase() === 'r') || input.key === 'F5') {
      if (activeTabId !== null) {
        const tab = tabs.get(activeTabId);
        if (tab) tab.view.webContents.reload();
      }
    }

    // ── Feature shortcuts ──
    // Ctrl+F → Toggle Find in Page
    if (ctrl && !input.shift && input.key.toLowerCase() === 'f') {
      sendToUI('toggle-find-in-page');
    }
    // Ctrl+K → Toggle Command Palette
    if (ctrl && !input.shift && input.key.toLowerCase() === 'k') {
      sendToUI('toggle-command-palette');
    }
    // Ctrl+P → Print active tab
    if (ctrl && !input.shift && input.key.toLowerCase() === 'p') {
      if (activeTabId !== null) {
        const tab = tabs.get(activeTabId);
        if (tab) tab.view.webContents.print();
      }
    }
    // Ctrl+\ → Toggle Split View
    if (ctrl && !input.shift && input.key === '\\') {
      sendToUI('toggle-split-view');
    }
    // Escape → Close overlays
    if (input.key === 'Escape') {
      sendToUI('escape-pressed');
    }

    // ── Zoom shortcuts ──
    // Ctrl+= or Ctrl++ → zoom in
    if (ctrl && !input.shift && (input.key === '=' || input.key === '+')) {
      if (activeTabId !== null) {
        const tab = tabs.get(activeTabId);
        if (tab) {
          const z = Math.min(tab.view.webContents.getZoomFactor() + 0.1, 3.0);
          tab.view.webContents.setZoomFactor(z);
          sendToUI('zoom-changed', Math.round(z * 100));
        }
      }
    }
    // Ctrl+- → zoom out
    if (ctrl && !input.shift && input.key === '-') {
      if (activeTabId !== null) {
        const tab = tabs.get(activeTabId);
        if (tab) {
          const z = Math.max(tab.view.webContents.getZoomFactor() - 0.1, 0.3);
          tab.view.webContents.setZoomFactor(z);
          sendToUI('zoom-changed', Math.round(z * 100));
        }
      }
    }
    // Ctrl+0 → reset zoom
    if (ctrl && !input.shift && input.key === '0') {
      if (activeTabId !== null) {
        const tab = tabs.get(activeTabId);
        if (tab) {
          tab.view.webContents.setZoomFactor(1.0);
          sendToUI('zoom-changed', 100);
        }
      }
    }
  }

  // Register on main webview (React UI)
  mainWindow.webContents.on('before-input-event', handleGlobalShortcut);
  // NOTE: Also registered on each tab's webContents in createTab() via registerTabShortcuts()

  mainWindow.on('closed', () => {
    mainWindow = null;
    rootView = null;
    mainWebView = null;
    if (screenshotInterval) clearInterval(screenshotInterval);
  });

  // Start screenshot capture at 1 FPS
  // NEVER inject visual badges — they bleed through to user. Use invisible element map only.
  let ssLogCount = 0;
  let ssInFlight = false;
  screenshotInterval = setInterval(async () => {
    if (ssInFlight) return; // Skip if previous capture still pending
    ssInFlight = true;
    ssLogCount++;

    if (!mainWindow) { ssInFlight = false; return; }
    try {
      // Multi-tab: capture ALL active agent tabs (for parallel executors)
      const agentTabEntries = Array.from(agentTabs.entries()); // [taskId, tabId][]
      if (agentTabEntries.length > 0) {
        for (const [taskId, tabId] of agentTabEntries) {
          const tab = tabs.get(tabId);
          if (tab && !tab.view.webContents.isDestroyed() && !privateTabIds.has(tabId)) {
            try {
              const wc = tab.view.webContents;
              const elementMap = await wc.executeJavaScript(GATHER_ELEMENTS_ONLY_JS);
              const image = await capturePageClean(wc, tabId);
              if (image && !image.isEmpty()) {
                const nat = image.getSize();
                const sc = 768 / Math.max(nat.width, nat.height, 1);
                const resized = image.resize({ width: Math.round(nat.width * sc), height: Math.round(nat.height * sc) });
                const buf = resized.toJPEG(85);
                const dims = resized.getSize();
                // Send per-task screenshot with taskId + actual dimensions
                mainWindow?.webContents?.send('screenshot-captured', buf.toString('base64'), elementMap, taskId, { width: dims.width, height: dims.height });
              }
            } catch {}
          }
        }
      }

      // Also capture the primary target (agentTabId or activeTabId) as session-level screenshot
      const targetId = agentTabId ?? activeTabId;
      let image, elementMap: any[] = [];
      if (targetId !== null && !privateTabIds.has(targetId)) {
        const tab = tabs.get(targetId);
        if (tab && !tab.view.webContents.isDestroyed()) {
          const wc = tab.view.webContents;
          elementMap = await wc.executeJavaScript(GATHER_ELEMENTS_ONLY_JS);
          image = await capturePageClean(wc, targetId);
        }
      }
      // Fallback: capture the main window (React UI / start page) if no tab screenshot
      if (!image || image.isEmpty()) {
        image = await mainWindow.webContents.capturePage();
      }
      if (!image || image.isEmpty()) return;
      const nat2 = image.getSize();
      const sc2 = 768 / Math.max(nat2.width, nat2.height, 1);
      const resized = image.resize({ width: Math.round(nat2.width * sc2), height: Math.round(nat2.height * sc2) });
      const buf = resized.toJPEG(85);
      const dims2 = resized.getSize();
      if (ssLogCount <= 5 || ssLogCount % 30 === 0) {
        console.log(`[screenshot] tick #${ssLogCount}: targetId=${targetId}, agentTabs=${agentTabEntries.length}, tabs=${tabs.size}, dims=${dims2.width}x${dims2.height}`);
      }
      mainWindow?.webContents?.send('screenshot-captured', buf.toString('base64'), elementMap, undefined, { width: dims2.width, height: dims2.height });

      // Bodyguard: paywall/popup detection heuristic (run every 10 captures)
      if (ssLogCount % 10 === 0 && targetId !== null && !privateTabIds.has(targetId)) {
        const tab = tabs.get(targetId);
        if (tab && !tab.view.webContents.isDestroyed()) {
          try {
            const paywallResult = await tab.view.webContents.executeJavaScript(`
              (function() {
                var score = 0;
                // Check for paywall/subscribe overlays
                var walls = document.querySelectorAll('[class*="paywall"], [class*="subscribe-wall"], [id*="paywall"], [class*="premium-wall"], [class*="registration-wall"], [class*="meter-"], [class*="gate"]');
                if (walls.length > 0) score += 3;
                // Check for prominent subscribe/unlock buttons
                var btns = document.querySelectorAll('button, a');
                for (var i = 0; i < Math.min(btns.length, 50); i++) {
                  var t = (btns[i].textContent || '').toLowerCase();
                  if (t.includes('subscribe') || t.includes('subskrybuj') || t.includes('unlock') || t.includes('premium') || t.includes('sign up to read')) score++;
                }
                // Content truncation patterns
                if (document.querySelector('[class*="truncat"], [class*="fade-out"], [class*="blur-content"], [class*="paywall-blur"]')) score += 2;
                // Fixed overlay covering content
                var overlays = document.querySelectorAll('div[style*="position: fixed"], div[style*="position:fixed"]');
                for (var j = 0; j < overlays.length; j++) {
                  var r = overlays[j].getBoundingClientRect();
                  if (r.width > window.innerWidth * 0.5 && r.height > window.innerHeight * 0.3) score += 2;
                }
                return { detected: score >= 4, score: score };
              })()
            `);
            if (paywallResult && paywallResult.detected) {
              mainWindow?.webContents?.send('paywall-detected', { tabId: targetId, score: paywallResult.score });
            }
          } catch {}
        }
      }
    } catch (e) {
      console.log(`[screenshot] error at tick #${ssLogCount}: ${e}`);
    } finally {
      ssInFlight = false;
    }
  }, 1000);

};

// ── Ad Blocker — block ad/tracking domains at network level ─────────
const AD_DOMAIN_PATTERNS = [
  '*://*.doubleclick.net/*', '*://*.googlesyndication.com/*', '*://*.googleadservices.com/*',
  '*://*.google-analytics.com/*', '*://*.googletagmanager.com/*', '*://*.googletagservices.com/*',
  '*://*.adnxs.com/*', '*://*.adsrvr.org/*', '*://*.adform.net/*', '*://*.advertising.com/*',
  '*://*.facebook.com/tr*', '*://*.facebook.net/signals/*', '*://*.fbcdn.net/signals/*',
  '*://*.amazon-adsystem.com/*', '*://*.aax.amazon-adsystem.com/*',
  '*://*.criteo.com/*', '*://*.criteo.net/*', '*://*.outbrain.com/*', '*://*.taboola.com/*',
  '*://*.rubiconproject.com/*', '*://*.pubmatic.com/*', '*://*.openx.net/*',
  '*://*.casalemedia.com/*', '*://*.indexww.com/*', '*://*.sharethrough.com/*',
  '*://*.smartadserver.com/*', '*://*.bidswitch.net/*', '*://*.contextweb.com/*',
  '*://*.admob.com/*', '*://*.moat.com/*', '*://*.serving-sys.com/*',
  '*://*.scorecardresearch.com/*', '*://*.quantserve.com/*', '*://*.bluekai.com/*',
  '*://*.krxd.net/*', '*://*.demdex.net/*', '*://*.rlcdn.com/*',
  '*://*.hotjar.com/*', '*://*.hotjar.io/*', '*://*.mixpanel.com/*',
  '*://*.segment.com/*', '*://*.segment.io/*', '*://*.amplitude.com/*',
  '*://*.ads-twitter.com/*', '*://*.ads.linkedin.com/*',
  '*://*.tpc.googlesyndication.com/*', '*://*.pagead2.googlesyndication.com/*',
  '*://*.ad.doubleclick.net/*', '*://*.static.doubleclick.net/*',
  '*://*.popads.net/*', '*://*.popcash.net/*', '*://*.propellerads.com/*',
  '*://creative.ak.fbcdn.net/*', '*://an.facebook.com/*',
  '*://*.medianet.com/*', '*://*.media.net/*',
  '*://*.yieldmanager.com/*', '*://*.zedo.com/*',
  // Polish ad/tracking networks
  '*://*.adocean.pl/*', '*://*.gemius.pl/*', '*://*.nsaudience.pl/*',
  '*://*.ocdn.eu/ad/*', '*://*.ocdn.eu/adx/*', '*://*.cmp.oath.com/*',
  '*://*.adskeeper.com/*', '*://*.revcontent.com/*',
  '*://*.hit.gemius.pl/*', '*://*.pro.hit.gemius.pl/*',
  '*://*.ad.wp.pl/*', '*://*.reklama.wp.pl/*',
  '*://*.adserver.pl/*', '*://*.geniee.pl/*',
];

// CSS to hide ads — SAFE selectors only, won't break real page elements
const HIDE_ADS_CSS = `
(function() {
  if (document.getElementById('lobster-adblock-css')) return;
  var s = document.createElement('style');
  s.id = 'lobster-adblock-css';
  s.textContent = \`
    /* Google Ads specific (won't match YouTube/Google's own UI) */
    [id*="google_ads_iframe"], ins.adsbygoogle, [class*="adsbygoogle"],
    /* Explicit ad containers — use ^ (starts-with) to avoid partial matches */
    .ad-banner, .ad-wrapper, .ad-unit,
    [id^="ad-container"], [id^="ad_container"],
    [class^="ad-container"], [class^="ad_container"],
    [id^="adslot"], [class^="adslot"], [id^="ad-slot"], [class^="ad-slot"],
    [id^="banner-ad"], [class^="banner-ad"], [class^="banner_ad"],
    /* Known ad network iframes (full domain match) */
    iframe[src*="doubleclick.net"], iframe[src*="googlesyndication.com"],
    iframe[src*="amazon-adsystem.com"], iframe[src*="adservice.google"],
    /* Taboola / Outbrain widgets */
    [id*="taboola"], [class*="taboola"],
    [id*="outbrain"], [class*="outbrain"],
    /* Explicit ad ARIA labels */
    div[aria-label="advertisement"], div[aria-label="Advertisements"],
    /* Cookie/consent banners */
    [class*="cookie-banner"], [class*="cookie-consent"], [id*="cookie-banner"],
    [class*="consent-banner"], [id*="consent-banner"],
    [class*="CookieBanner"], [id*="CookieBanner"],
    [class^="gdpr-"], [id^="gdpr-"],
    /* Polish ad labels (starts-with to avoid false matches) */
    [class^="rekl"], [id^="rekl"],
    /* DFP */
    [class^="dfp-"], [id^="dfp-"],
    /* AMP ads */
    amp-ad, amp-embed, amp-sticky-ad
  { display: none !important; visibility: hidden !important; height: 0 !important; max-height: 0 !important; min-height: 0 !important; padding: 0 !important; margin: 0 !important; overflow: hidden !important; border: none !important; opacity: 0 !important; pointer-events: none !important; }
  \`;
  document.head.appendChild(s);

  /* JS-based ad collapse — only targets known ad patterns */
  function collapseAds() {
    /* Hide standalone "REKLAMA" labels inside ad wrappers */
    document.querySelectorAll('div, span').forEach(function(el) {
      var txt = el.textContent.trim();
      if ((txt === 'REKLAMA' || txt === 'Reklama' || txt === 'reklama') && el.children.length <= 1 && el.offsetHeight < 50) {
        var parent = el.closest('[class*="ad-"], [class*="ad_"], [id*="ad-"], [id*="ad_"]');
        if (parent) { parent.style.cssText = 'display:none!important;height:0!important;overflow:hidden!important;'; }
      }
    });
    /* Kill iframes from known ad domains */
    document.querySelectorAll('iframe').forEach(function(f) {
      var src = f.src || '';
      if (src && (src.includes('doubleclick.net') || src.includes('googlesyndication.com') || src.includes('amazon-adsystem.com') || src.includes('adservice.google'))) {
        f.style.cssText = 'display:none!important;height:0!important;';
        var p = f.parentElement;
        if (p && p.children.length <= 2) p.style.cssText += 'height:0!important;max-height:0!important;overflow:hidden!important;';
      }
    });
  }
  collapseAds();
  setTimeout(collapseAds, 2000);
  setTimeout(collapseAds, 5000);
})()`;

// Enhanced cookie dismiss with MutationObserver for late-loading banners
const COOKIE_OBSERVER_JS = `
(function() {
  if (window.__lobsterCookieObserver) return;
  window.__lobsterCookieObserver = true;
  function tryDismiss() { ${DISMISS_COOKIES_JS.replace(/^\(function\(\)\{/, '').replace(/\}\)\(\)$/, '')} }
  tryDismiss();
  var obs = new MutationObserver(function(mutations) {
    for (var m of mutations) {
      for (var n of m.addedNodes) {
        if (n.nodeType === 1) {
          var cl = (n.className || '').toLowerCase();
          var id = (n.id || '').toLowerCase();
          if (cl.indexOf('cookie') !== -1 || cl.indexOf('consent') !== -1 ||
              cl.indexOf('gdpr') !== -1 || cl.indexOf('privacy') !== -1 ||
              id.indexOf('cookie') !== -1 || id.indexOf('consent') !== -1) {
            setTimeout(tryDismiss, 200);
            return;
          }
        }
      }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
  setTimeout(function() { obs.disconnect(); }, 15000);
})()`;

app.on('ready', () => {
  // Set Chrome-like user-agent globally — fixes Google SSO/OAuth 400 errors
  session.defaultSession.setUserAgent(CHROME_UA);

  // Auto-grant microphone permission
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(true);
  });

  // Ad blocker — block requests to ad/tracking domains
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: AD_DOMAIN_PATTERNS },
    (_details, callback) => {
      callback({ cancel: true });
    }
  );

  // Register asset path IPC BEFORE window loads (prevents race condition)
  ipcMain.handle('get-asset-path', async (_event, filename: string) => {
    const fs = require('fs');
    const assetPath = path.join(__dirname, 'assets', filename);
    console.log(`[asset] Resolving: ${filename} → ${assetPath} (exists: ${fs.existsSync(assetPath)})`);
    if (fs.existsSync(assetPath)) {
      // Return data URL — works regardless of CSP/protocol restrictions
      const buf = fs.readFileSync(assetPath);
      const ext = path.extname(filename).slice(1);
      const mime = ext === 'mp4' ? 'video/mp4' : ext === 'webm' ? 'video/webm' : `application/octet-stream`;
      return `data:${mime};base64,${buf.toString('base64')}`;
    }
    return '';
  });

  createWindow();
  setupIPC();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
