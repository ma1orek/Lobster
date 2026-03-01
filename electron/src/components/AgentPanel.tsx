import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface LogEntry {
  type: 'user' | 'agent' | 'action' | 'error';
  text: string;
  timestamp: number;
}

interface AgentPanelProps {
  log: LogEntry[];
  agentState: 'idle' | 'listening' | 'thinking' | 'speaking' | 'acting';
}

const stateColors: Record<string, string> = {
  listening: '#4ade80',
  thinking: '#facc15',
  speaking: '#ff2b44',
};

const stateLabels: Record<string, string> = {
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

export default function AgentPanel({ log, agentState }: AgentPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  const visibleLog = log
    .filter(e => e.type === 'user' || e.type === 'agent' || e.type === 'action')
    .slice(-6);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [visibleLog.length]);

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      padding: '8px 16px 6px',
      gap: 4,
      overflow: 'hidden',
    }}>
      {/* State indicator */}
      {agentState !== 'idle' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <motion.div
            style={{ width: 6, height: 6, borderRadius: '50%', background: stateColors[agentState] || '#fff', flexShrink: 0 }}
            animate={{ scale: [1, 1.4, 1], opacity: [0.6, 1, 0.6] }}
            transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
          />
          <span style={{ fontSize: 11, color: stateColors[agentState] || '#fff', fontWeight: 500, letterSpacing: '0.03em' }}>
            {stateLabels[agentState] || agentState}
          </span>
        </div>
      )}

      {/* Messages */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 5 }}>
        <AnimatePresence initial={false}>
          {visibleLog.map((entry, i) => {
            const isUser = entry.type === 'user';
            const isAction = entry.type === 'action';

            return (
              <motion.div
                key={`${entry.timestamp}-${i}`}
                initial={{ opacity: 0, y: 10, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}
              >
                <div style={{
                  maxWidth: '78%',
                  padding: isAction ? '3px 10px' : '6px 12px',
                  borderRadius: isUser ? '14px 14px 3px 14px' : '14px 14px 14px 3px',
                  background: isUser
                    ? 'rgba(255, 43, 68, 0.2)'
                    : isAction
                    ? 'rgba(250, 204, 21, 0.12)'
                    : 'rgba(30, 30, 30, 0.9)',
                  border: isUser
                    ? '1px solid rgba(255, 43, 68, 0.3)'
                    : isAction
                    ? '1px solid rgba(250, 204, 21, 0.25)'
                    : '1px solid rgba(255,255,255,0.07)',
                }}>
                  <span style={{
                    fontSize: isAction ? 11 : 12,
                    color: isUser
                      ? 'rgba(255,255,255,0.95)'
                      : isAction
                      ? 'rgba(250,204,21,0.9)'
                      : 'rgba(255,255,255,0.82)',
                    fontFamily: isAction ? 'ui-monospace, monospace' : "'Inter', sans-serif",
                    lineHeight: 1.45,
                    display: 'block',
                  }}>
                    {isAction ? `⚡ ${entry.text}` : entry.text}
                  </span>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
