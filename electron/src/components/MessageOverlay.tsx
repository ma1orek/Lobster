import React, { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface LogEntry {
  type: 'user' | 'agent' | 'action' | 'error' | 'thought' | 'tool_call' | 'task_status' | 'screenshot';
  text: string;
  timestamp: number;
  toolType?: string;
  screenshotBase64?: string;
}

interface MessageOverlayProps {
  log: LogEntry[];
  agentState: 'idle' | 'listening' | 'thinking' | 'speaking' | 'acting';
}

interface VisibleMsg {
  id: string;
  text: string;
  isUser: boolean;
  fadeAt: number;
  logIndex: number; // track which log entry this corresponds to
}

const MSG_LIFETIME = 6000;
const MAX_VISIBLE = 4;

export default function MessageOverlay({ log, agentState }: MessageOverlayProps) {
  const [visible, setVisible] = useState<VisibleMsg[]>([]);
  const prevLenRef = useRef(0);
  const prevLastTextRef = useRef('');

  // Sync visible messages with log — handles both new entries AND merged text updates
  useEffect(() => {
    const now = Date.now();

    if (log.length > prevLenRef.current) {
      // New entries added
      const newEntries = log.slice(prevLenRef.current);
      const newMsgs: VisibleMsg[] = newEntries
        .filter(e => e.type === 'agent' || e.type === 'user')
        .map((entry, i) => ({
          id: `${entry.timestamp}-${prevLenRef.current + i}`,
          text: entry.text,
          isUser: entry.type === 'user',
          fadeAt: now + MSG_LIFETIME,
          logIndex: prevLenRef.current + i,
        }));

      if (newMsgs.length > 0) {
        setVisible(prev => [...prev, ...newMsgs].slice(-MAX_VISIBLE));
      }
      prevLenRef.current = log.length;
      prevLastTextRef.current = log.length > 0 ? log[log.length - 1].text : '';
    } else if (log.length === prevLenRef.current && log.length > 0) {
      // Same length — check if last entry's text was updated (merged transcript)
      const lastEntry = log[log.length - 1];
      if (lastEntry.text !== prevLastTextRef.current && (lastEntry.type === 'agent' || lastEntry.type === 'user')) {
        prevLastTextRef.current = lastEntry.text;
        // Update the matching visible message's text + extend fade timer
        setVisible(prev => {
          const updated = prev.map(m => {
            if (m.logIndex === log.length - 1) {
              return { ...m, text: lastEntry.text, fadeAt: Math.max(m.fadeAt, now + MSG_LIFETIME) };
            }
            return m;
          });
          // If no match found (somehow), add it
          if (!updated.some(m => m.logIndex === log.length - 1)) {
            updated.push({
              id: `${lastEntry.timestamp}-${log.length - 1}`,
              text: lastEntry.text,
              isUser: lastEntry.type === 'user',
              fadeAt: now + MSG_LIFETIME,
              logIndex: log.length - 1,
            });
          }
          return updated.slice(-MAX_VISIBLE);
        });
      }
    }
  }, [log]);

  // Fade timer
  useEffect(() => {
    if (visible.length === 0) return;
    const soonest = Math.min(...visible.map(m => m.fadeAt));
    const delay = Math.max(100, soonest - Date.now());
    const timer = setTimeout(() => {
      const now = Date.now();
      setVisible(prev => prev.filter(m => m.fadeAt > now));
    }, delay);
    return () => clearTimeout(timer);
  }, [visible]);

  // Keep messages alive while agent is speaking
  useEffect(() => {
    if (agentState === 'speaking') {
      setVisible(prev => prev.map(m => ({
        ...m,
        fadeAt: Math.max(m.fadeAt, Date.now() + 3000),
      })));
    }
  }, [agentState]);

  return (
    <div style={{
      position: 'absolute',
      bottom: 24,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 40,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 8,
      pointerEvents: 'none',
      width: '90%',
      maxWidth: 520,
    }}>
      <AnimatePresence initial={false}>
        {visible.map((msg) => (
          <motion.div
            key={msg.id}
            layout
            initial={{ opacity: 0, y: 24, scale: 0.92, filter: 'blur(8px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -12, scale: 0.95, filter: 'blur(6px)' }}
            transition={{
              duration: 0.45,
              ease: [0.16, 1, 0.3, 1],
              layout: { duration: 0.3, ease: [0.16, 1, 0.3, 1] },
            }}
            style={{
              maxWidth: '100%',
              padding: '10px 20px',
              borderRadius: 20,
              background: msg.isUser
                ? 'linear-gradient(135deg, rgba(255, 43, 68, 0.18) 0%, rgba(200, 20, 50, 0.12) 100%)'
                : 'linear-gradient(135deg, rgba(18, 18, 24, 0.65) 0%, rgba(10, 10, 16, 0.55) 100%)',
              backdropFilter: 'blur(32px) saturate(1.4)',
              WebkitBackdropFilter: 'blur(32px) saturate(1.4)',
              border: msg.isUser
                ? '1px solid rgba(255, 43, 68, 0.25)'
                : '1px solid rgba(255, 255, 255, 0.08)',
              boxShadow: '0 4px 32px rgba(0,0,0,0.35), 0 1px 8px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.06)',
              color: 'rgba(255,255,255,0.92)',
              fontSize: 13.5,
              fontFamily: "'Inter', sans-serif",
              fontWeight: 400,
              lineHeight: 1.5,
              textAlign: 'center',
              letterSpacing: '0.005em',
              textShadow: '0 1px 4px rgba(0,0,0,0.4)',
            }}
          >
            {msg.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
