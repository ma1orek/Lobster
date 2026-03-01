import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface FindBarProps {
  visible: boolean;
  onClose: () => void;
}

export default function FindBar({ visible, onClose }: FindBarProps) {
  const [query, setQuery] = useState('');
  const [activeMatch, setActiveMatch] = useState(0);
  const [totalMatches, setTotalMatches] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (visible) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery('');
      setActiveMatch(0);
      setTotalMatches(0);
    }
  }, [visible]);

  useEffect(() => {
    window.pulse.onFindInPageResult((result: { matches: number; activeMatchOrdinal: number }) => {
      setTotalMatches(result.matches);
      setActiveMatch(result.activeMatchOrdinal);
    });
  }, []);

  const doFind = useCallback((text: string, forward = true) => {
    if (text) {
      window.pulse.findInPage(text, { forward, findNext: true });
    } else {
      window.pulse.stopFindInPage();
      setActiveMatch(0);
      setTotalMatches(0);
    }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    doFind(val);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doFind(query, !e.shiftKey);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      window.pulse.stopFindInPage();
      onClose();
    }
  };

  const close = () => {
    window.pulse.stopFindInPage();
    onClose();
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: -12, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -12, scale: 0.96 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          style={{
            position: 'fixed',
            top: 92,
            right: 16,
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 8px 5px 12px',
            background: 'rgba(18,18,22,0.92)',
            backdropFilter: 'blur(24px) saturate(1.3)',
            WebkitBackdropFilter: 'blur(24px) saturate(1.3)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 12,
            boxShadow: '0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06)',
          }}
        >
          {/* Search icon */}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>

          <input
            ref={inputRef}
            value={query}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="Find on page..."
            style={{
              width: 180,
              height: 26,
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 7,
              padding: '0 8px',
              color: '#fff',
              fontSize: 12,
              fontFamily: "'Inter', sans-serif",
              outline: 'none',
            }}
          />

          {/* Match count */}
          {query && (
            <span style={{
              fontSize: 10.5,
              color: totalMatches > 0 ? 'rgba(255,255,255,0.5)' : 'rgba(255,80,80,0.7)',
              fontFamily: "'Inter', sans-serif",
              whiteSpace: 'nowrap',
              minWidth: 40,
              textAlign: 'center',
            }}>
              {totalMatches > 0 ? `${activeMatch} / ${totalMatches}` : 'No results'}
            </span>
          )}

          {/* Prev */}
          <button onClick={() => doFind(query, false)} title="Previous (Shift+Enter)" style={findBtn}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="18 15 12 9 6 15"/></svg>
          </button>

          {/* Next */}
          <button onClick={() => doFind(query, true)} title="Next (Enter)" style={findBtn}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>

          {/* Close */}
          <button onClick={close} title="Close (Esc)" style={findBtn}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const findBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 24, height: 24, borderRadius: 6,
  border: 'none', background: 'rgba(255,255,255,0.04)',
  color: 'rgba(255,255,255,0.5)', cursor: 'pointer',
  transition: 'all 0.15s ease',
};
