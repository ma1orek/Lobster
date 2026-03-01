import React, { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface VoiceOrbProps {
  mode: 'idle' | 'compact';
  state: 'idle' | 'listening' | 'thinking' | 'speaking' | 'acting';
  wsConnected: boolean;
  awake: boolean;
  // Controlled mic state (lifted to App.tsx)
  muted: boolean;
  micActive: boolean;
  audioLevel: number;
  onToggleMute: () => void;
  // Text command support
  sendTextCommand: (text: string) => void;
  onChatToggle?: () => void;
}

export default function VoiceOrb({
  mode,
  state,
  wsConnected,
  awake,
  muted,
  micActive,
  audioLevel,
  onToggleMute,
  sendTextCommand,
  onChatToggle,
}: VoiceOrbProps) {
  const [textInput, setTextInput] = useState('');
  const [compactInputOpen, setCompactInputOpen] = useState(false);

  const handleTextSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (textInput.trim()) {
      sendTextCommand(textInput.trim());
      setTextInput('');
      setCompactInputOpen(false);
    }
  }, [textInput, sendTextCommand]);

  // Active = awake + mic on (ALWAYS show red animation when awake, not just listening/speaking)
  const isActive = !muted && awake;
  const isHot = isActive && (state === 'listening' || state === 'speaking');
  const ringScale = isActive ? 1 + audioLevel * (isHot ? 0.5 : 0.2) : 1;

  const stateColor = !awake ? 'rgba(255,255,255,0.15)' : '#ff2b44'; // Always red when awake
  const showPulse = isActive; // Always show pulse when awake + unmuted
  // Dormant pulse — subtle breathing when waiting for wake word
  const showDormantPulse = !muted && !awake && wsConnected;

  // ── COMPACT MODE (in chrome bar) ────────────────────────────────
  if (mode === 'compact') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, position: 'relative' }}>
        {/* Audio-reactive glow ring behind mic button (active) */}
        {showPulse && (
          <motion.div
            animate={{
              scale: [1, 1.3 + audioLevel * 0.4, 1],
              opacity: [0.3, 0.6 + audioLevel * 0.3, 0.3],
            }}
            transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
            style={{
              position: 'absolute',
              right: 0, top: '50%',
              width: 28, height: 28,
              marginTop: -14,
              borderRadius: 8,
              border: `1.5px solid ${stateColor}`,
              boxShadow: `0 0 16px ${stateColor}44, 0 0 32px ${stateColor}22`,
              pointerEvents: 'none',
              zIndex: 0,
            }}
          />
        )}
        {/* Dormant breathing pulse — waiting for wake word */}
        {showDormantPulse && !showPulse && (
          <motion.div
            animate={{
              scale: [1, 1.1, 1],
              opacity: [0.1, 0.25, 0.1],
            }}
            transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
            style={{
              position: 'absolute',
              right: 0, top: '50%',
              width: 28, height: 28,
              marginTop: -14,
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.1)',
              pointerEvents: 'none',
              zIndex: 0,
            }}
          />
        )}
        {/* Text input popover — glass */}
        <AnimatePresence>
          {compactInputOpen && (
            <motion.form
              key="compact-input"
              initial={{ opacity: 0, width: 0, x: 10 }}
              animate={{ opacity: 1, width: 220, x: 0 }}
              exit={{ opacity: 0, width: 0, x: 10 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              onSubmit={handleTextSubmit}
              style={{
                position: 'absolute', right: 36, top: '50%',
                transform: 'translateY(-50%)',
                background: 'linear-gradient(135deg, rgba(18, 18, 22, 0.8) 0%, rgba(12, 12, 16, 0.75) 100%)',
                backdropFilter: 'blur(32px) saturate(1.3)',
                WebkitBackdropFilter: 'blur(32px) saturate(1.3)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 12,
                overflow: 'hidden',
                display: 'flex',
                boxShadow: '0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.06)',
              }}
            >
              <input
                autoFocus
                type="text"
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                placeholder="Tell Lobster what to do..."
                style={{
                  flex: 1, background: 'transparent', border: 'none', outline: 'none',
                  color: '#fff', fontSize: 12.5, padding: '8px 12px',
                  fontFamily: "'Inter', sans-serif",
                  letterSpacing: '0.01em',
                }}
                onKeyDown={(e) => e.key === 'Escape' && setCompactInputOpen(false)}
              />
            </motion.form>
          )}
        </AnimatePresence>

        {/* Mic button — glass */}
        <motion.button
          onClick={onToggleMute}
          whileTap={{ scale: 0.88 }}
          animate={isActive ? { scale: [1, 1.05, 1] } : { scale: 1 }}
          transition={{ duration: 1.2, repeat: isActive ? Infinity : 0, ease: 'easeInOut' }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, borderRadius: 8,
            border: isActive ? '1px solid rgba(255,43,68,0.35)' : '1px solid rgba(255,255,255,0.07)',
            background: muted
              ? 'rgba(255,255,255,0.04)'
              : isActive
              ? 'linear-gradient(135deg, rgba(255, 43, 68, 0.22) 0%, rgba(255, 43, 68, 0.12) 100%)'
              : 'rgba(255,255,255,0.04)',
            cursor: 'pointer', flexShrink: 0,
            boxShadow: isActive
              ? '0 0 16px rgba(255,43,68,0.25), inset 0 1px 0 rgba(255,255,255,0.06)'
              : 'inset 0 1px 0 rgba(255,255,255,0.04)',
            transition: 'background 0.2s, box-shadow 0.2s, border-color 0.2s',
          }}
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="1" y1="1" x2="23" y2="23" />
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
              <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.35 2.17" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
              stroke={isActive ? '#ff2b44' : 'rgba(255,255,255,0.7)'}
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          )}
        </motion.button>
      </div>
    );
  }

  // ── IDLE MODE (centered in flex parent) ─────────────
  return (
    <div style={{ position: 'relative' }}>

      {/* Audio reactive ring — red glow (always when awake) */}
      {isActive && (
        <>
          {/* Outer breathing ring */}
          <motion.div
            animate={{
              scale: isHot ? [1, 1.08 + audioLevel * 0.4, 1] : [1, 1.04, 1],
              opacity: isHot ? [0.3, 0.7 + audioLevel * 0.3, 0.3] : [0.15, 0.35, 0.15],
            }}
            transition={{ duration: isHot ? 0.8 : 2, repeat: Infinity, ease: 'easeInOut' }}
            style={{
              position: 'absolute', inset: -14,
              borderRadius: 40,
              border: '1.5px solid rgba(255,43,68,0.6)',
              boxShadow: `0 0 ${isHot ? 30 : 16}px rgba(255,43,68,${isHot ? 0.25 : 0.1})`,
              pointerEvents: 'none',
            }}
          />
          {/* Inner glow ring — reacts to audio level immediately */}
          <motion.div
            animate={{ scale: ringScale, opacity: 0.2 + audioLevel * 0.6 }}
            transition={{ duration: 0.05 }}
            style={{
              position: 'absolute', inset: -6,
              borderRadius: 34,
              border: '1px solid rgba(255,43,68,0.4)',
              boxShadow: '0 0 12px rgba(255,43,68,0.12)',
              pointerEvents: 'none',
            }}
          />
        </>
      )}
      {/* Dormant breathing ring — waiting for wake word */}
      {showDormantPulse && !isActive && (
        <motion.div
          animate={{ scale: [1, 1.05, 1], opacity: [0.1, 0.2, 0.1] }}
          transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
          style={{
            position: 'absolute', inset: -6,
            borderRadius: 34,
            border: '1px solid rgba(255,255,255,0.08)',
            pointerEvents: 'none',
          }}
        />
      )}

      <form
        onSubmit={handleTextSubmit}
        style={{
          display: 'flex', alignItems: 'center',
          width: 400, height: 56,
          background: 'linear-gradient(135deg, rgba(18, 18, 22, 0.6) 0%, rgba(10, 10, 14, 0.55) 100%)',
          backdropFilter: 'blur(40px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(40px) saturate(1.4)',
          border: isActive
            ? '1px solid rgba(255, 43, 68, 0.35)'
            : '1px solid rgba(255, 255, 255, 0.1)',
          borderRadius: 28,
          boxShadow: isActive
            ? '0 8px 48px rgba(255,43,68,0.15), 0 2px 12px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08)'
            : '0 8px 40px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08)',
          overflow: 'hidden',
          transition: 'border-color 0.3s, box-shadow 0.3s',
        }}
      >
        <input
          type="text"
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
          placeholder={
            !wsConnected ? 'Connecting...' :
            muted ? 'Type or say "Hey, Lobster"' :
            !awake ? 'Type or say "Hey, Lobster"' :
            state === 'listening' ? 'Listening...' :
            state === 'thinking' ? 'Thinking...' :
            state === 'speaking' ? 'Speaking...' :
            'Type or speak...'
          }
          style={{
            flex: 1, height: '100%', background: 'transparent',
            padding: '0 22px', color: '#fff', fontSize: 15,
            fontFamily: "'Inter', sans-serif",
            outline: 'none', border: 'none',
            letterSpacing: '0.01em',
          }}
        />

        {/* Mic button — glass circle */}
        <motion.button
          type="button"
          onClick={onToggleMute}
          whileTap={{ scale: 0.88 }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 42, height: 42, borderRadius: '50%',
            border: isActive ? '1px solid rgba(255,43,68,0.3)' : '1px solid rgba(255,255,255,0.08)',
            cursor: 'pointer',
            background: muted
              ? 'rgba(255,255,255,0.05)'
              : isActive
              ? 'linear-gradient(135deg, rgba(255, 43, 68, 0.2) 0%, rgba(255, 43, 68, 0.1) 100%)'
              : 'rgba(255,255,255,0.05)',
            marginRight: 7, flexShrink: 0,
            boxShadow: isActive
              ? '0 0 12px rgba(255,43,68,0.2), inset 0 1px 0 rgba(255,255,255,0.06)'
              : 'inset 0 1px 0 rgba(255,255,255,0.05)',
            transition: 'all 0.25s ease',
          }}
        >
          {muted ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="1" y1="1" x2="23" y2="23" />
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
              <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.35 2.17" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          ) : (
            <motion.svg
              width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke={isActive ? '#ff2b44' : 'rgba(255,255,255,0.8)'}
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              animate={isActive ? { scale: [1, 1.1, 1] } : { scale: 1 }}
              transition={{ duration: 1.4, repeat: isActive ? Infinity : 0 }}
            >
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </motion.svg>
          )}
        </motion.button>

        {/* Send button (appears when text typed) */}
        <AnimatePresence>
          {textInput.trim() && (
            <motion.button
              key="send"
              type="submit"
              initial={{ opacity: 0, scale: 0.7, width: 0, marginRight: 0 }}
              animate={{ opacity: 1, scale: 1, width: 42, marginRight: 7 }}
              exit={{ opacity: 0, scale: 0.7, width: 0, marginRight: 0 }}
              transition={{ duration: 0.18 }}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: 42, borderRadius: '50%',
                border: '1px solid rgba(255,43,68,0.3)',
                background: 'linear-gradient(135deg, rgba(255, 43, 68, 0.35) 0%, rgba(255, 43, 68, 0.2) 100%)',
                cursor: 'pointer', flexShrink: 0, overflow: 'hidden',
                boxShadow: '0 0 12px rgba(255,43,68,0.15), inset 0 1px 0 rgba(255,255,255,0.08)',
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </motion.button>
          )}
        </AnimatePresence>
      </form>
    </div>
  );
}
