import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface Tab {
  id: number;
  url: string;
  title: string;
  active: boolean;
  isAgent?: boolean;
  isPrivate?: boolean;
}

interface CronJob {
  task: string;
  interval: number;
  lastResult?: string;
  lastTickTime?: number;
  currentAction?: string;
  step?: number;
  maxSteps?: number;
  running?: boolean;
  url?: string;
}

interface TabBarProps {
  tabs: Tab[];
  activeTabId: number | null;
  cronJobs: Record<string, CronJob>;
  onSwitchTab: (id: number) => void;
  onCloseTab: (id: number) => void;
  onNewTab: () => void;
  onCancelCron: (jobId: string) => void;
  onDuplicateTab?: (id: number) => void;
  onCloseOtherTabs?: (id: number) => void;
  onCloseTabsToRight?: (id: number) => void;
}

const WORKER_COLORS = [
  { main: '#818cf8', bg: 'rgba(100, 110, 250, 0.15)', border: 'rgba(130, 140, 250, 0.35)', glow: 'rgba(130, 140, 250, 0.12)', text: 'rgba(180, 190, 255, 0.9)' },
  { main: '#34d399', bg: 'rgba(52, 211, 153, 0.12)', border: 'rgba(52, 211, 153, 0.35)', glow: 'rgba(52, 211, 153, 0.1)', text: 'rgba(160, 240, 210, 0.9)' },
  { main: '#fb923c', bg: 'rgba(251, 146, 60, 0.12)', border: 'rgba(251, 146, 60, 0.35)', glow: 'rgba(251, 146, 60, 0.1)', text: 'rgba(255, 200, 160, 0.9)' },
  { main: '#f472b6', bg: 'rgba(244, 114, 182, 0.12)', border: 'rgba(244, 114, 182, 0.35)', glow: 'rgba(244, 114, 182, 0.1)', text: 'rgba(255, 180, 220, 0.9)' },
  { main: '#22d3ee', bg: 'rgba(34, 211, 238, 0.12)', border: 'rgba(34, 211, 238, 0.35)', glow: 'rgba(34, 211, 238, 0.1)', text: 'rgba(160, 240, 250, 0.9)' },
];

function getHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function getFavicon(url: string): string {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`;
  } catch {
    return '';
  }
}

function CronCountdown({ interval, lastTickTime, running, color }: { interval: number; lastTickTime?: number; running?: boolean; color: string }) {
  const [remaining, setRemaining] = useState(interval);

  useEffect(() => {
    const tick = () => {
      if (lastTickTime) {
        const elapsed = (Date.now() - lastTickTime) / 1000;
        const r = Math.ceil(interval - elapsed);
        // When timer expires, don't show negative — show 0 briefly then wrap around
        if (r <= 0) {
          // If cron is running (executing), show 0; otherwise it probably just hasn't updated yet
          setRemaining(running ? 0 : Math.ceil(interval - (elapsed % interval)));
        } else {
          setRemaining(r);
        }
      } else {
        setRemaining(interval);
      }
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [interval, lastTickTime, running]);

  if (running && remaining <= 0) {
    return (
      <span style={{
        fontSize: 9, fontWeight: 600, fontFamily: "'Inter', sans-serif",
        color, letterSpacing: '-0.02em', flexShrink: 0,
      }}>
        ...
      </span>
    );
  }

  return (
    <span style={{
      fontSize: 9.5, fontWeight: 700, fontFamily: "'Inter', sans-serif",
      color: remaining <= 3 ? color : `${color}99`,
      fontVariantNumeric: 'tabular-nums', minWidth: 20, textAlign: 'right',
      flexShrink: 0, letterSpacing: '-0.02em',
    }}>
      {remaining}s
    </span>
  );
}

export default function TabBar({ tabs, activeTabId, cronJobs, onSwitchTab, onCloseTab, onNewTab, onCancelCron, onDuplicateTab, onCloseOtherTabs, onCloseTabsToRight }: TabBarProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: number } | null>(null);
  const [hoveredCronTab, setHoveredCronTab] = useState<number | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, tabId: number) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, tabId });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const cronEntries = Object.entries(cronJobs);

  // Match cron jobs to ANY tab (including agent tabs) by hostname
  // Track which tabs are "claimed" by a cron, and which crons are unmatched
  const { tabCronMap, unmatchedCrons, cronTabIds } = useMemo(() => {
    const map: Record<number, { jobId: string; job: CronJob; colorIdx: number }> = {};
    const matched = new Set<string>();
    const hiddenTabIds = new Set<number>();

    cronEntries.forEach(([jobId, job], idx) => {
      if (!job.url) return;
      const cronHost = getHostname(job.url);
      if (!cronHost) return;

      // Find best matching tab — prefer non-agent tabs, but accept agent tabs too
      let bestTab: Tab | null = null;
      for (const tab of tabs) {
        const tabHost = getHostname(tab.url);
        if (tabHost && tabHost === cronHost) {
          if (!bestTab || (!tab.isAgent && bestTab.isAgent)) {
            bestTab = tab;
          }
        }
      }
      if (bestTab && !map[bestTab.id]) {
        map[bestTab.id] = { jobId, job, colorIdx: idx };
        matched.add(jobId);
        // If we matched a non-agent tab AND there's also an agent tab with same host, hide the agent tab
        if (!bestTab.isAgent) {
          for (const tab of tabs) {
            if (tab.isAgent && getHostname(tab.url) === cronHost) {
              hiddenTabIds.add(tab.id);
            }
          }
        }
      }
    });

    const unmatched = cronEntries
      .filter(([jobId]) => !matched.has(jobId))
      .map(([jobId, job]) => {
        const originalIdx = cronEntries.findIndex(([id]) => id === jobId);
        return { jobId, job, colorIdx: originalIdx };
      });

    return { tabCronMap: map, unmatchedCrons: unmatched, cronTabIds: hiddenTabIds };
  }, [tabs, cronEntries]);

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: '4px',
        overflowX: 'auto', scrollbarWidth: 'none', height: '100%',
      }}
      onClick={closeContextMenu}
    >
      {/* Tab context menu — positioned ABOVE click point */}
      {contextMenu && (() => {
        const menuH = 230; // approx menu height
        const menuY = Math.max(4, contextMenu.y - menuH); // Above click point, clamped to viewport
        const menuX = Math.min(contextMenu.x, window.innerWidth - 200); // Don't overflow right
        const tabIdx = tabs.findIndex(t => t.id === contextMenu.tabId);
        const tabsToRight = tabs.filter((_, i) => i > tabIdx && !tabs[i].isAgent).length;
        const otherTabs = tabs.filter(t => t.id !== contextMenu.tabId && !t.isAgent).length;
        return (
        <div onClick={closeContextMenu} style={{ position: 'fixed', inset: 0, zIndex: 500 }}>
          <div onClick={e => e.stopPropagation()} style={{
            position: 'fixed', left: menuX, top: menuY,
            background: 'rgba(14,14,18,0.96)', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 10, padding: '4px 0',
            backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
            boxShadow: '0 -8px 40px rgba(0,0,0,0.5), 0 4px 20px rgba(0,0,0,0.3)', zIndex: 501, minWidth: 200,
          }}>
            {/* Duplicate Tab */}
            {onDuplicateTab && (
              <button
                onClick={() => { onDuplicateTab(contextMenu.tabId); closeContextMenu(); }}
                style={ctxMenuBtn}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                <span>Duplicate Tab</span>
              </button>
            )}
            {/* Toggle AI Access */}
            <button
              onClick={async () => { await window.pulse.togglePrivateTab(contextMenu.tabId); closeContextMenu(); }}
              style={ctxMenuBtn}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {tabs.find(t => t.id === contextMenu.tabId)?.isPrivate ? (
                  <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>
                ) : (
                  <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></>
                )}
              </svg>
              <span>{tabs.find(t => t.id === contextMenu.tabId)?.isPrivate ? 'Enable AI Access' : 'Disable AI Access'}</span>
            </button>
            <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '2px 8px' }} />
            {/* Close Tab */}
            <button
              onClick={() => { onCloseTab(contextMenu.tabId); closeContextMenu(); }}
              style={ctxMenuBtn}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
              <span>Close Tab</span>
            </button>
            {/* Close Tabs to the Right */}
            {onCloseTabsToRight && tabsToRight > 0 && (
              <button
                onClick={() => { onCloseTabsToRight(contextMenu.tabId); closeContextMenu(); }}
                style={ctxMenuBtn}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18l6-6-6-6"/>
                  <line x1="18" y1="6" x2="18" y2="18"/>
                </svg>
                <span>Close {tabsToRight} Tab{tabsToRight > 1 ? 's' : ''} to Right</span>
              </button>
            )}
            {/* Close Other Tabs */}
            {onCloseOtherTabs && otherTabs > 0 && (
              <button
                onClick={() => { onCloseOtherTabs(contextMenu.tabId); closeContextMenu(); }}
                style={{ ...ctxMenuBtn, color: 'rgba(255,100,100,0.7)' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,60,60,0.08)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
                <span>Close Other Tabs</span>
              </button>
            )}
          </div>
        </div>
        );
      })()}

      <AnimatePresence initial={false}>
        {tabs.map((tab) => {
          // Show agent tabs — they're the executor working (lobster emoji visible)
          // Only hide if this agent tab is a duplicate of a cron-claimed non-agent tab
          // Hide agent tabs that are duplicates of a cron-claimed non-agent tab
          if (cronTabIds.has(tab.id)) return null;

          const isActive = tab.id === activeTabId;
          const isAgent = tab.isAgent || false;
          const isPrivate = tab.isPrivate || false;
          const favicon = isAgent ? '' : getFavicon(tab.url);
          const displayTitle = isAgent
            ? (tab.title || '🦞 Agent')
            : (tab.title && tab.title !== 'New Tab' ? tab.title : (tab.url || 'New Tab'));

          // Cron overlay for this tab
          const cronInfo = tabCronMap[tab.id];
          const hasCron = !!cronInfo;
          const colors = hasCron ? WORKER_COLORS[cronInfo.colorIdx % WORKER_COLORS.length] : null;
          const cronRunning = cronInfo?.job.running || false;
          const isHovered = hoveredCronTab === tab.id;

          return (
            <motion.div
              key={tab.id}
              layout
              initial={{ opacity: 0, scale: 0.85, x: -8 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
              exit={{ opacity: 0, scale: 0.8, x: -8, width: 0, marginRight: 0, padding: 0 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              onClick={() => onSwitchTab(tab.id)}
              onContextMenu={(e) => handleContextMenu(e, tab.id)}
              onMouseEnter={() => hasCron && setHoveredCronTab(tab.id)}
              onMouseLeave={() => setHoveredCronTab(null)}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '4px 10px 4px 8px', height: '30px', borderRadius: '10px',
                cursor: 'pointer', position: 'relative',
                background: hasCron
                  ? colors!.bg
                  : isActive
                    ? (isAgent
                      ? 'linear-gradient(135deg, rgba(255, 160, 43, 0.2) 0%, rgba(255, 100, 43, 0.1) 100%)'
                      : 'linear-gradient(135deg, rgba(255, 43, 68, 0.2) 0%, rgba(255, 43, 68, 0.1) 100%)')
                    : (isAgent ? 'rgba(255, 160, 43, 0.06)' : 'rgba(255, 255, 255, 0.04)'),
                border: hasCron
                  ? `1px solid ${colors!.border}`
                  : isActive
                    ? (isAgent ? '1px solid rgba(255, 160, 43, 0.4)' : '1px solid rgba(255, 43, 68, 0.35)')
                    : (isAgent ? '1px solid rgba(255, 160, 43, 0.15)' : '1px solid rgba(255, 255, 255, 0.06)'),
                boxShadow: hasCron
                  ? `0 0 8px ${colors!.glow}, inset 0 1px 0 rgba(255,255,255,0.05)`
                  : isActive
                    ? '0 0 12px rgba(255, 43, 68, 0.12), inset 0 1px 0 rgba(255,255,255,0.06)'
                    : 'inset 0 1px 0 rgba(255,255,255,0.03)',
                maxWidth: '200px', flexShrink: 0, overflow: 'hidden',
                transition: 'background 0.2s, border-color 0.2s, box-shadow 0.2s',
                WebkitAppRegion: 'no-drag',
              } as React.CSSProperties}
            >
              {/* Icon: cron rotating icon OR normal favicon */}
              {hasCron ? (
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: cronRunning ? 1 : 3, repeat: Infinity, ease: 'linear' }}
                  style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={colors!.main} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10"/>
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                  </svg>
                </motion.div>
              ) : isAgent ? (
                (!tab.url || tab.url === 'about:blank') ? (
                  <motion.div
                    animate={{ scale: [1, 1.3, 1], opacity: [0.6, 1, 0.6] }}
                    transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
                    style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: '#ffa02b', boxShadow: '0 0 8px rgba(255,160,43,0.4)',
                      flexShrink: 0,
                    }}
                  />
                ) : (
                  <span style={{ fontSize: 13, flexShrink: 0, lineHeight: 1 }}>🦞</span>
                )
              ) : isPrivate ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,180,60,0.8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                  <line x1="1" y1="1" x2="23" y2="23"/>
                </svg>
              ) : favicon ? (
                <img src={favicon} alt="" style={{ width: 14, height: 14, borderRadius: 3, flexShrink: 0, opacity: isActive ? 1 : 0.6 }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              ) : null}

              {/* Tab title — AnimatePresence swap for cron tabs on hover */}
              <AnimatePresence mode="wait" initial={false}>
                {hasCron && isHovered && cronRunning && cronInfo.job.currentAction ? (
                  <motion.span
                    key="cron-action"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.12 }}
                    style={{
                      fontSize: '10.5px', fontWeight: 600,
                      fontFamily: "'Inter', sans-serif",
                      color: colors!.main,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      maxWidth: '100px', letterSpacing: '-0.01em', lineHeight: 1,
                    }}
                  >
                    {cronInfo.job.currentAction}
                  </motion.span>
                ) : (
                  <motion.span
                    key="tab-title"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.12 }}
                    style={{
                      fontSize: '11.5px', fontWeight: isActive || hasCron ? 500 : 400,
                      fontFamily: "'Inter', sans-serif",
                      color: isAgent && (!tab.url || tab.url === 'about:blank')
                        ? 'rgba(255, 160, 43, 0.7)'
                        : hasCron ? colors!.text : (isActive ? '#fff' : 'rgba(255,255,255,0.5)'),
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      maxWidth: '100px', letterSpacing: '-0.01em', lineHeight: 1,
                    }}
                  >
                    {isAgent && (!tab.url || tab.url === 'about:blank') ? 'Loading…' : displayTitle}
                  </motion.span>
                )}
              </AnimatePresence>

              {/* Cron: always show countdown timer */}
              {hasCron && (
                <CronCountdown interval={cronInfo.job.interval} lastTickTime={cronInfo.job.lastTickTime} running={cronInfo.job.running} color={colors!.main} />
              )}

              {/* Close / cancel button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (hasCron) {
                    onCancelCron(cronInfo.jobId);
                  } else {
                    onCloseTab(tab.id);
                  }
                }}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 14, height: 14, borderRadius: '50%', border: 'none',
                  background: 'transparent',
                  color: hasCron ? `${colors!.main}66` : (isActive ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.3)'),
                  cursor: 'pointer', flexShrink: 0, padding: 0,
                  transition: 'color 0.15s, background 0.15s',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,43,68,0.3)';
                  (e.currentTarget as HTMLButtonElement).style.color = '#fff';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                  (e.currentTarget as HTMLButtonElement).style.color = hasCron ? `${colors!.main}66` : (isActive ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.3)');
                }}
              >
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                  <path d="M1 1l6 6M7 1l-6 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
              </button>

              {/* ── HOVER TOOLTIP — always shows task, live status when running ── */}
              <AnimatePresence>
                {hasCron && isHovered && (
                  <motion.div
                    initial={{ opacity: 0, y: 4, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 4, scale: 0.95 }}
                    transition={{ duration: 0.15 }}
                    style={{
                      position: 'absolute',
                      top: '100%', left: 0, marginTop: 6, zIndex: 600,
                      background: 'rgba(12, 12, 16, 0.95)',
                      backdropFilter: 'blur(16px)',
                      border: `1px solid ${colors!.border}`,
                      borderRadius: 10, padding: '8px 12px',
                      minWidth: 220, maxWidth: 320,
                      boxShadow: `0 8px 32px rgba(0,0,0,0.5), 0 0 12px ${colors!.glow}`,
                      pointerEvents: 'none',
                    }}
                  >
                    {/* Recurring task label */}
                    <div style={{
                      fontSize: 8.5, fontWeight: 600, textTransform: 'uppercase',
                      letterSpacing: '0.08em', color: `${colors!.main}88`,
                      fontFamily: "'Inter', sans-serif", marginBottom: 3,
                    }}>
                      Recurring task
                    </div>
                    {/* Task description */}
                    <div style={{
                      fontSize: 11, fontWeight: 500, color: colors!.text,
                      fontFamily: "'Inter', sans-serif", marginBottom: 6,
                      lineHeight: 1.3,
                    }}>
                      {cronInfo.job.task}
                    </div>

                    {cronRunning && cronInfo.job.currentAction ? (
                      <>
                        <div style={{
                          fontSize: 10, color: 'rgba(255,255,255,0.8)',
                          fontFamily: "'Inter', sans-serif",
                          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5,
                        }}>
                          <motion.div
                            animate={{ scale: [1, 1.4, 1] }}
                            transition={{ duration: 0.8, repeat: Infinity }}
                            style={{ width: 6, height: 6, borderRadius: '50%', background: colors!.main, flexShrink: 0 }}
                          />
                          <span style={{ flex: 1 }}>{cronInfo.job.currentAction}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ flex: 1, height: 4, borderRadius: 2, background: `${colors!.main}22`, overflow: 'hidden' }}>
                            <motion.div
                              animate={{ width: `${((cronInfo.job.step || 0) / (cronInfo.job.maxSteps || 15)) * 100}%` }}
                              transition={{ duration: 0.3 }}
                              style={{ height: '100%', background: colors!.main, borderRadius: 2 }}
                            />
                          </div>
                          <span style={{
                            fontSize: 9, color: `${colors!.main}99`, fontFamily: "'Inter', sans-serif",
                            fontVariantNumeric: 'tabular-nums', flexShrink: 0,
                          }}>
                            step {cronInfo.job.step || 0}/{cronInfo.job.maxSteps || 15}
                          </span>
                        </div>
                      </>
                    ) : cronInfo.job.lastResult ? (
                      <div style={{
                        fontSize: 10, color: 'rgba(255,255,255,0.5)',
                        fontFamily: "'Inter', sans-serif", lineHeight: 1.3,
                      }}>
                        {cronInfo.job.lastResult.slice(0, 80)}
                      </div>
                    ) : (
                      <div style={{
                        fontSize: 10, color: 'rgba(255,255,255,0.35)',
                        fontFamily: "'Inter', sans-serif",
                      }}>
                        Waiting for first run...
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
      </AnimatePresence>

      {/* ── UNMATCHED CRON TABS — no matching browser tab yet ── */}
      <AnimatePresence initial={false}>
        {unmatchedCrons.map(({ jobId, job, colorIdx }) => {
          const colors = WORKER_COLORS[colorIdx % WORKER_COLORS.length];
          const isRunning = job.running || false;
          const shortTask = job.task.length > 20 ? job.task.slice(0, 20) + '…' : job.task;

          return (
            <motion.div
              key={`cron-${jobId}`}
              layout
              initial={{ opacity: 0, scale: 0.85, x: -8 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
              exit={{ opacity: 0, scale: 0.8, x: -8, width: 0 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              title={`${job.task}\n${job.lastResult || 'Waiting...'}`}
              style={{
                display: 'flex', alignItems: 'center', gap: '5px',
                padding: '4px 7px 4px 5px', height: '30px', borderRadius: '10px',
                cursor: 'default',
                background: colors.bg,
                border: `1px solid ${colors.border}`,
                boxShadow: `0 0 6px ${colors.glow}, inset 0 1px 0 rgba(255,255,255,0.04)`,
                maxWidth: '200px', flexShrink: 0, overflow: 'hidden',
                transition: 'max-width 0.3s ease, box-shadow 0.3s ease',
                WebkitAppRegion: 'no-drag',
              } as React.CSSProperties}
            >
              <motion.div animate={{ rotate: 360 }} transition={{ duration: isRunning ? 1 : 3, repeat: Infinity, ease: 'linear' }}
                style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={colors.main} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
              </motion.div>
              <span style={{
                fontSize: '10px', fontWeight: 500, fontFamily: "'Inter', sans-serif",
                color: colors.text, whiteSpace: 'nowrap', overflow: 'hidden',
                textOverflow: 'ellipsis', lineHeight: 1,
              }}>
                {shortTask}
              </span>
              <CronCountdown interval={job.interval} lastTickTime={job.lastTickTime} running={job.running} color={colors.main} />
              <button onClick={(e) => { e.stopPropagation(); onCancelCron(jobId); }}
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 13, height: 13, borderRadius: '50%', border: 'none', background: 'transparent', color: `${colors.main}66`, cursor: 'pointer', flexShrink: 0, padding: 0, transition: 'color 0.15s, background 0.15s' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,60,60,0.25)'; (e.currentTarget as HTMLButtonElement).style.color = '#ff6060'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = `${colors.main}66`; }}
              >
                <svg width="7" height="7" viewBox="0 0 8 8" fill="none"><path d="M1 1l6 6M7 1l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>

      {/* New Tab button */}
      <motion.button layout whileHover={{ scale: 1.08, background: 'rgba(255, 43, 68, 0.15)' }} whileTap={{ scale: 0.92 }}
        onClick={onNewTab}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
          minWidth: tabs.filter(t => !t.isAgent).length === 0 ? 100 : 28,
          height: 28, borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.07)',
          background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.5)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)', cursor: 'pointer', flexShrink: 0,
          fontSize: 12, transition: 'color 0.15s, min-width 0.3s ease',
          padding: tabs.filter(t => !t.isAgent).length === 0 ? '0 12px' : 0,
          fontFamily: "'Inter', sans-serif", WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
          <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        </svg>
        {tabs.filter(t => !t.isAgent).length === 0 && <span>New Tab</span>}
      </motion.button>
    </div>
  );
}

const ctxMenuBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  width: '100%', padding: '7px 12px',
  background: 'transparent', border: 'none',
  color: 'rgba(255,255,255,0.7)', fontSize: 12,
  fontFamily: "'Inter', sans-serif",
  cursor: 'pointer', textAlign: 'left',
  transition: 'background 0.1s ease',
};
