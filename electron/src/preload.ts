import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pulse', {
  // Tab management
  createTab: (url: string) => ipcRenderer.invoke('create-tab', url),
  switchTab: (id: number) => ipcRenderer.invoke('switch-tab', id),
  closeTab: (id: number) => ipcRenderer.invoke('close-tab', id),
  navigate: (url: string) => ipcRenderer.invoke('navigate', url),
  getTabs: () => ipcRenderer.invoke('get-tabs'),

  // Browser actions (from agent)
  executeAction: (action: any) => ipcRenderer.invoke('execute-action', action),

  // Agent-specific: actions target agent's background tab, not user's active tab
  // taskId enables multi-tab executor — each task gets its own tab
  agentNavigate: (url: string, taskId?: string) => ipcRenderer.invoke('agent-navigate', url, taskId),
  agentCreateTab: (url: string, taskId?: string) => ipcRenderer.invoke('agent-create-tab', url, taskId),
  agentCloseTab: (taskId?: string) => ipcRenderer.invoke('agent-close-tab', taskId),
  resetAgentTab: () => ipcRenderer.invoke('reset-agent-tab'),

  // Screenshots
  captureScreenshot: () => ipcRenderer.invoke('capture-screenshot'),
  captureTaskScreenshot: (taskId: string) => ipcRenderer.invoke('capture-task-screenshot', taskId),

  // Gallery
  openGalleryTab: () => ipcRenderer.invoke('open-gallery-tab'),
  executeOnGallery: (code: string) => ipcRenderer.invoke('execute-on-gallery', code),

  // Navigation
  goBack: () => ipcRenderer.invoke('go-back'),
  goForward: () => ipcRenderer.invoke('go-forward'),

  // Find in Page
  findInPage: (text: string, options?: { forward?: boolean; findNext?: boolean }) =>
    ipcRenderer.invoke('find-in-page', text, options),
  stopFindInPage: () => ipcRenderer.invoke('stop-find-in-page'),

  // Print
  printPage: () => ipcRenderer.send('print-page'),

  // Window controls (frame: false)
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
  windowClose:    () => ipcRenderer.send('window-close'),

  // JS-based window drag (CSS app-region doesn't work with WebContentsView)
  windowDragStart: () => ipcRenderer.send('window-drag-start'),
  windowDragMove:  () => ipcRenderer.send('window-drag-move'),
  windowDragEnd:   () => ipcRenderer.send('window-drag-end'),

  // Window state
  isMaximized: () => ipcRenderer.invoke('is-maximized'),

  // Zoom controls
  zoomIn: () => ipcRenderer.invoke('zoom-in'),
  zoomOut: () => ipcRenderer.invoke('zoom-out'),
  zoomReset: () => ipcRenderer.invoke('zoom-reset'),
  getZoom: () => ipcRenderer.invoke('get-zoom'),

  // Downloads
  getDownloads: () => ipcRenderer.invoke('get-downloads'),
  openDownloads: () => ipcRenderer.send('open-downloads'),

  // Chrome bar height (expand/collapse for agent panel)
  setChromeHeight: (height: number) => ipcRenderer.send('set-chrome-height', height),
  // Right panel width (task history drawer — shrinks WebContentsView)
  setRightPanelWidth: (width: number) => ipcRenderer.send('set-right-panel-width', width),

  // Event listeners
  onTabCreated: (cb: (data: any) => void) => {
    ipcRenderer.on('tab-created', (_e, data) => cb(data));
  },
  onTabUpdated: (cb: (data: any) => void) => {
    ipcRenderer.on('tab-updated', (_e, data) => cb(data));
  },
  onTabSwitched: (cb: (data: any) => void) => {
    ipcRenderer.on('tab-switched', (_e, data) => cb(data));
  },
  onTabClosed: (cb: (data: any) => void) => {
    ipcRenderer.on('tab-closed', (_e, data) => cb(data));
  },
  onScreenshotCaptured: (cb: (base64: string, elementMap?: any[], taskId?: string) => void) => {
    ipcRenderer.on('screenshot-captured', (_e, data, elementMap, taskId) => cb(data, elementMap, taskId));
  },
  onMaximizeChanged: (cb: (isMaximized: boolean) => void) => {
    ipcRenderer.on('maximize-changed', (_e, isMax) => cb(isMax));
  },
  onDownloadUpdate: (cb: (downloads: any[]) => void) => {
    ipcRenderer.on('download-update', (_e, downloads) => cb(downloads));
  },
  onZoomChanged: (cb: (zoom: number) => void) => {
    ipcRenderer.on('zoom-changed', (_e, zoom) => cb(zoom));
  },
  onFindInPageResult: (cb: (result: any) => void) => {
    ipcRenderer.on('find-in-page-result', (_e, result) => cb(result));
  },
  // Keyboard shortcut events from main process
  onFocusUrlBar: (cb: () => void) => {
    ipcRenderer.on('focus-url-bar', () => cb());
  },
  onToggleFindInPage: (cb: () => void) => {
    ipcRenderer.on('toggle-find-in-page', () => cb());
  },
  onToggleCommandPalette: (cb: () => void) => {
    ipcRenderer.on('toggle-command-palette', () => cb());
  },
  onEscapePressed: (cb: () => void) => {
    ipcRenderer.on('escape-pressed', () => cb());
  },
  // Action guardrails
  onConfirmAction: (cb: (data: { action: string; url: string; requestId: string }) => void) => {
    ipcRenderer.on('confirm-action', (_e, data) => cb(data));
  },
  respondConfirmAction: (requestId: string, allowed: boolean) =>
    ipcRenderer.send('confirm-action-response', requestId, allowed),
  // Ghost tab (agent working in background)
  peekGhostTab: () => ipcRenderer.invoke('peek-ghost-tab'),
  unpeekGhostTab: () => ipcRenderer.invoke('unpeek-ghost-tab'),
  onGhostTabStarted: (cb: (data: any) => void) => {
    ipcRenderer.on('ghost-tab-started', (_e, data) => cb(data));
  },
  onGhostTabUpdated: (cb: (data: any) => void) => {
    ipcRenderer.on('ghost-tab-updated', (_e, data) => cb(data));
  },
  onGhostTabEnded: (cb: (data: any) => void) => {
    ipcRenderer.on('ghost-tab-ended', (_e, data) => cb(data));
  },
  // Incognito without AI
  togglePrivateTab: (tabId: number) => ipcRenderer.invoke('toggle-private-tab', tabId),
  isPrivateTab: (tabId: number) => ipcRenderer.invoke('is-private-tab', tabId),
  // Split View
  setSplitTab: (tabId: number | null) => ipcRenderer.invoke('set-split-tab', tabId),
  getSplitTab: () => ipcRenderer.invoke('get-split-tab'),
  onSplitViewChanged: (cb: (data: any) => void) => {
    ipcRenderer.on('split-view-changed', (_e, data) => cb(data));
  },
  onToggleSplitView: (cb: () => void) => {
    ipcRenderer.on('toggle-split-view', () => cb());
  },
  // Focus Mode
  toggleFocusMode: () => ipcRenderer.invoke('toggle-focus-mode'),
  onFocusModeChanged: (cb: (focusMode: boolean) => void) => {
    ipcRenderer.on('focus-mode-changed', (_e, fm) => cb(fm));
  },
  // Bodyguard — paywall detection
  onPaywallDetected: (cb: (data: { tabId: number; score: number }) => void) => {
    ipcRenderer.on('paywall-detected', (_e, data) => cb(data));
  },
  // Asset path resolver
  getAssetPath: (filename: string) => ipcRenderer.invoke('get-asset-path', filename),
});
