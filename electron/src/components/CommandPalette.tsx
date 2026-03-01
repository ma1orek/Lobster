import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface Tab {
  id: number;
  url: string;
  title: string;
  active: boolean;
  isAgent?: boolean;
}

interface PaletteItem {
  id: string;
  category: 'tab' | 'skill' | 'action' | 'nav';
  label: string;
  description?: string;
  icon?: string;
  action: () => void;
}

interface CommandPaletteProps {
  visible: boolean;
  onClose: () => void;
  tabs: Tab[];
  onSwitchTab: (id: number) => void;
  onNewTab: (url?: string) => void;
  sendTextCommand: (text: string) => void;
}

const QUICK_NAV = [
  { label: 'Google', url: 'https://www.google.com', icon: 'G' },
  { label: 'YouTube', url: 'https://www.youtube.com', icon: 'Y' },
  { label: 'GitHub', url: 'https://github.com', icon: 'GH' },
  { label: 'Gmail', url: 'https://mail.google.com', icon: 'GM' },
  { label: 'Twitter / X', url: 'https://x.com', icon: 'X' },
  { label: 'Excalidraw', url: 'https://excalidraw.com', icon: 'EX' },
  { label: 'ChatGPT', url: 'https://chat.openai.com', icon: 'AI' },
  { label: 'Reddit', url: 'https://www.reddit.com', icon: 'R' },
];

const AGENT_SKILLS = [
  { label: 'Research this topic', cmd: 'Research the topic currently visible on the page and summarize key findings' },
  { label: 'Summarize this page', cmd: 'Read and summarize the current page content' },
  { label: 'Fill this form', cmd: 'Help me fill out the form on this page' },
  { label: 'Extract data from page', cmd: 'Extract the main data/content from this page and present it clearly' },
  { label: 'Find best price', cmd: 'Search multiple sources to find the best price for the product on this page' },
  { label: 'Compare alternatives', cmd: 'Find and compare alternatives to what is shown on this page' },
];

function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

export default function CommandPalette({ visible, onClose, tabs, onSwitchTab, onNewTab, sendTextCommand }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (visible) {
      setQuery('');
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [visible]);

  const items = useMemo((): PaletteItem[] => {
    const all: PaletteItem[] = [];

    // Open tabs
    tabs.forEach(t => {
      all.push({
        id: `tab-${t.id}`,
        category: 'tab',
        label: t.title || 'New Tab',
        description: t.url || '',
        icon: t.isAgent ? 'L' : 'T',
        action: () => { onSwitchTab(t.id); onClose(); },
      });
    });

    // Agent skills
    AGENT_SKILLS.forEach((s, i) => {
      all.push({
        id: `skill-${i}`,
        category: 'skill',
        label: s.label,
        description: 'Agent skill',
        icon: 'A',
        action: () => { sendTextCommand(s.cmd); onClose(); },
      });
    });

    // Actions
    all.push({ id: 'action-newtab', category: 'action', label: 'New Tab', icon: '+', action: () => { onNewTab(); onClose(); } });
    all.push({ id: 'action-closetab', category: 'action', label: 'Close Tab', icon: 'X', action: () => { if (tabs.find(t => t.active)) window.pulse.closeTab(tabs.find(t => t.active)!.id); onClose(); } });
    all.push({ id: 'action-downloads', category: 'action', label: 'Open Downloads', icon: 'D', action: () => { window.pulse.openDownloads(); onClose(); } });
    all.push({ id: 'action-zoomin', category: 'action', label: 'Zoom In', icon: 'Z+', action: () => { window.pulse.zoomIn(); onClose(); } });
    all.push({ id: 'action-zoomout', category: 'action', label: 'Zoom Out', icon: 'Z-', action: () => { window.pulse.zoomOut(); onClose(); } });
    all.push({ id: 'action-zoomreset', category: 'action', label: 'Reset Zoom', icon: 'Z0', action: () => { window.pulse.zoomReset(); onClose(); } });
    all.push({ id: 'action-focusmode', category: 'action', label: 'Focus Mode', description: 'Hide chrome, just page + voice', icon: 'F', action: () => { window.pulse.toggleFocusMode(); onClose(); } });
    all.push({ id: 'action-print', category: 'action', label: 'Print Page', icon: 'P', action: () => { window.pulse.printPage(); onClose(); } });

    // Quick nav
    QUICK_NAV.forEach((n, i) => {
      all.push({
        id: `nav-${i}`,
        category: 'nav',
        label: n.label,
        description: n.url,
        icon: n.icon,
        action: () => { onNewTab(n.url); onClose(); },
      });
    });

    return all;
  }, [tabs, onSwitchTab, onNewTab, sendTextCommand, onClose]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    return items.filter(item =>
      fuzzyMatch(query, item.label) || fuzzyMatch(query, item.description || '')
    );
  }, [query, items]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const el = listRef.current.children[selectedIdx] as HTMLElement;
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIdx]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIdx]) filtered[selectedIdx].action();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [filtered, selectedIdx, onClose]);

  const categoryLabels: Record<string, string> = {
    tab: 'Open Tabs',
    skill: 'Agent Skills',
    action: 'Actions',
    nav: 'Quick Navigate',
  };

  const categoryIcons: Record<string, string> = {
    tab: 'rgba(100,180,255,0.8)',
    skill: 'rgba(255,43,68,0.8)',
    action: 'rgba(250,204,21,0.8)',
    nav: 'rgba(74,222,128,0.8)',
  };

  // Group for section headers
  let lastCategory = '';

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={onClose}
          style={{
            position: 'fixed', inset: 0, zIndex: 200,
            background: 'rgba(5,5,5,0.7)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            paddingTop: 120,
          }}
        >
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.96 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            onClick={e => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 560,
              background: 'rgba(18,18,22,0.92)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 16,
              boxShadow: '0 24px 80px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)',
              overflow: 'hidden',
            }}
          >
            {/* Search input */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '14px 16px',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input
                ref={inputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a command or search..."
                style={{
                  flex: 1,
                  background: 'none',
                  border: 'none',
                  color: '#fff',
                  fontSize: 14,
                  fontFamily: "'Inter', sans-serif",
                  outline: 'none',
                }}
              />
              <kbd style={{
                fontSize: 10, color: 'rgba(255,255,255,0.25)',
                padding: '2px 6px', borderRadius: 4,
                border: '1px solid rgba(255,255,255,0.08)',
                fontFamily: 'monospace',
              }}>ESC</kbd>
            </div>

            {/* Results list */}
            <div
              ref={listRef}
              style={{
                maxHeight: 380,
                overflowY: 'auto',
                padding: '4px 0',
              }}
            >
              {filtered.length === 0 && (
                <div style={{
                  padding: '24px 16px',
                  textAlign: 'center',
                  color: 'rgba(255,255,255,0.3)',
                  fontSize: 13,
                  fontFamily: "'Inter', sans-serif",
                }}>
                  No results found
                </div>
              )}
              {filtered.map((item, i) => {
                const showHeader = item.category !== lastCategory;
                lastCategory = item.category;
                const isSelected = i === selectedIdx;

                return (
                  <React.Fragment key={item.id}>
                    {showHeader && (
                      <div style={{
                        padding: '8px 16px 4px',
                        fontSize: 10,
                        fontWeight: 600,
                        color: 'rgba(255,255,255,0.3)',
                        fontFamily: "'Inter', sans-serif",
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                      }}>
                        {categoryLabels[item.category]}
                      </div>
                    )}
                    <div
                      onClick={() => item.action()}
                      onMouseEnter={() => setSelectedIdx(i)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 16px',
                        cursor: 'pointer',
                        background: isSelected ? 'rgba(255,43,68,0.12)' : 'transparent',
                        borderLeft: isSelected ? '2px solid rgba(255,43,68,0.6)' : '2px solid transparent',
                        transition: 'all 0.1s ease',
                      }}
                    >
                      {/* Category dot */}
                      <div style={{
                        width: 24, height: 24, borderRadius: 6,
                        background: 'rgba(255,255,255,0.06)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 9, fontWeight: 700, flexShrink: 0,
                        color: categoryIcons[item.category] || 'rgba(255,255,255,0.4)',
                        fontFamily: 'monospace',
                      }}>
                        {item.icon}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 13, color: '#fff',
                          fontFamily: "'Inter', sans-serif",
                          fontWeight: 400,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}>
                          {item.label}
                        </div>
                        {item.description && (
                          <div style={{
                            fontSize: 10.5,
                            color: 'rgba(255,255,255,0.3)',
                            fontFamily: "'Inter', sans-serif",
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}>
                            {item.description}
                          </div>
                        )}
                      </div>
                    </div>
                  </React.Fragment>
                );
              })}
            </div>

            {/* Footer hint */}
            <div style={{
              padding: '8px 16px',
              borderTop: '1px solid rgba(255,255,255,0.06)',
              display: 'flex', alignItems: 'center', gap: 12,
              fontSize: 10, color: 'rgba(255,255,255,0.2)',
              fontFamily: "'Inter', sans-serif",
            }}>
              <span><kbd style={kbdStyle}>↑↓</kbd> Navigate</span>
              <span><kbd style={kbdStyle}>Enter</kbd> Select</span>
              <span><kbd style={kbdStyle}>Esc</kbd> Close</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const kbdStyle: React.CSSProperties = {
  fontSize: 9, padding: '1px 4px', borderRadius: 3,
  border: '1px solid rgba(255,255,255,0.1)',
  fontFamily: 'monospace', color: 'rgba(255,255,255,0.3)',
};
