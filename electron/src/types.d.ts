interface PulseAPI {
  createTab: (url: string) => Promise<{ id: number; url: string }>;
  switchTab: (id: number) => Promise<{ success: boolean }>;
  closeTab: (id: number) => Promise<{ success: boolean }>;
  navigate: (url: string) => Promise<{ success: boolean }>;
  goBack: () => Promise<{ success: boolean }>;
  goForward: () => Promise<{ success: boolean }>;
  windowMinimize: () => void;
  windowMaximize: () => void;
  windowClose: () => void;
  windowDragStart: () => void;
  windowDragMove: () => void;
  windowDragEnd: () => void;
  isMaximized: () => Promise<boolean>;
  zoomIn: () => Promise<number>;
  zoomOut: () => Promise<number>;
  zoomReset: () => Promise<number>;
  getZoom: () => Promise<number>;
  getDownloads: () => Promise<Array<{ filename: string; url: string; state: string; receivedBytes: number; totalBytes: number }>>;
  openDownloads: () => void;
  getTabs: () => Promise<Array<{ id: number; url: string; title: string; active: boolean }>>;
  executeAction: (action: any) => Promise<{ success: boolean; text?: string; error?: string }>;
  agentNavigate: (url: string, taskId?: string) => Promise<{ success: boolean; agentTabId?: number; taskId?: string }>;
  agentCreateTab: (url: string, taskId?: string) => Promise<{ id: number; url: string }>;
  agentCloseTab: (taskId?: string) => Promise<{ success: boolean }>;
  resetAgentTab: () => Promise<{ success: boolean }>;
  captureScreenshot: () => Promise<string | null>;
  captureTaskScreenshot: (taskId: string) => Promise<string | null>;
  openGalleryTab: () => Promise<{ id: number }>;
  executeOnGallery: (code: string) => Promise<string | null>;
  // Find in Page
  findInPage: (text: string, options?: { forward?: boolean; findNext?: boolean }) => Promise<void>;
  stopFindInPage: () => Promise<void>;
  // Print
  printPage: () => void;
  // Event listeners
  onTabCreated: (cb: (data: { id: number; url: string; title: string }) => void) => void;
  onTabUpdated: (cb: (data: { id: number; url: string; title: string }) => void) => void;
  onTabSwitched: (cb: (data: { id: number }) => void) => void;
  onTabClosed: (cb: (data: { id: number }) => void) => void;
  onScreenshotCaptured: (cb: (base64: string, elementMap?: any[], taskId?: string) => void) => void;
  onMaximizeChanged: (cb: (isMaximized: boolean) => void) => void;
  onDownloadUpdate: (cb: (downloads: Array<{ filename: string; state: string; progress: number }>) => void) => void;
  onZoomChanged: (cb: (zoom: number) => void) => void;
  onFindInPageResult: (cb: (result: { matches: number; activeMatchOrdinal: number }) => void) => void;
  // Keyboard shortcut events from main process
  onFocusUrlBar: (cb: () => void) => void;
  onToggleFindInPage: (cb: () => void) => void;
  onToggleCommandPalette: (cb: () => void) => void;
  onEscapePressed: (cb: () => void) => void;
  setChromeHeight: (height: number) => void;
  setRightPanelWidth: (width: number) => void;
  // Action guardrails
  onConfirmAction: (cb: (data: { action: string; url: string; requestId: string }) => void) => void;
  respondConfirmAction: (requestId: string, allowed: boolean) => void;
  // Ghost tab (agent working in background)
  peekGhostTab: () => Promise<{ success: boolean }>;
  unpeekGhostTab: () => Promise<{ success: boolean }>;
  onGhostTabStarted: (cb: (data: { id: number; url: string; title: string }) => void) => void;
  onGhostTabUpdated: (cb: (data: { id: number; url: string; title: string }) => void) => void;
  onGhostTabEnded: (cb: (data: { id: number }) => void) => void;
  // Incognito without AI
  togglePrivateTab: (tabId: number) => Promise<{ success: boolean; isPrivate: boolean }>;
  isPrivateTab: (tabId: number) => Promise<boolean>;
  // Split View
  setSplitTab: (tabId: number | null) => Promise<{ success: boolean; splitTabId: number | null }>;
  getSplitTab: () => Promise<number | null>;
  onSplitViewChanged: (cb: (data: { splitTabId: number | null }) => void) => void;
  onToggleSplitView: (cb: () => void) => void;
  // Focus Mode
  toggleFocusMode: () => Promise<{ success: boolean; focusMode: boolean }>;
  onFocusModeChanged: (cb: (focusMode: boolean) => void) => void;
  // Bodyguard — paywall detection
  onPaywallDetected: (cb: (data: { tabId: number; score: number }) => void) => void;
  // Asset path resolver
  getAssetPath: (filename: string) => Promise<string>;
}

declare global {
  interface Window {
    pulse: PulseAPI;
  }
}

export {};
