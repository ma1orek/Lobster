import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface ConfirmModalProps {
  visible: boolean;
  action: string;
  url: string;
  onAllow: () => void;
  onDeny: () => void;
}

export default function ConfirmModal({ visible, action, url, onAllow, onDeny }: ConfirmModalProps) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          style={{
            position: 'fixed', inset: 0, zIndex: 300,
            background: 'rgba(5,5,5,0.6)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 10 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            style={{
              width: '100%',
              maxWidth: 420,
              background: 'rgba(18,18,22,0.95)',
              border: '1px solid rgba(255,60,60,0.25)',
              borderRadius: 16,
              boxShadow: '0 24px 80px rgba(0,0,0,0.6), 0 0 40px rgba(255,43,68,0.1), inset 0 1px 0 rgba(255,255,255,0.06)',
              padding: '24px',
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            }}
          >
            {/* Warning icon */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 10,
                background: 'rgba(255,60,60,0.12)',
                border: '1px solid rgba(255,60,60,0.2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 18,
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ff4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                  <line x1="12" y1="9" x2="12" y2="13"/>
                  <line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
              </div>
              <div>
                <div style={{
                  fontSize: 15, fontWeight: 600, color: '#fff',
                  fontFamily: "'Inter', sans-serif",
                }}>
                  Agent Action Requires Approval
                </div>
              </div>
            </div>

            {/* Description */}
            <div style={{
              fontSize: 13, color: 'rgba(255,255,255,0.6)',
              fontFamily: "'Inter', sans-serif",
              lineHeight: 1.5,
            }}>
              The agent wants to perform a potentially sensitive action:
            </div>

            {/* Action detail */}
            <div style={{
              padding: '10px 12px',
              background: 'rgba(255,60,60,0.06)',
              border: '1px solid rgba(255,60,60,0.12)',
              borderRadius: 10,
            }}>
              <div style={{
                fontSize: 12.5, fontWeight: 600, color: 'rgba(255,180,180,0.9)',
                fontFamily: "'Inter', sans-serif",
                marginBottom: 4,
              }}>
                {action}
              </div>
              <div style={{
                fontSize: 11, color: 'rgba(255,255,255,0.35)',
                fontFamily: "'Inter', sans-serif",
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}>
                on {url}
              </div>
            </div>

            {/* Buttons */}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={onDeny}
                style={{
                  padding: '8px 20px',
                  borderRadius: 10,
                  border: '1px solid rgba(255,255,255,0.1)',
                  background: 'rgba(255,255,255,0.06)',
                  color: 'rgba(255,255,255,0.6)',
                  fontSize: 13, fontWeight: 500,
                  fontFamily: "'Inter', sans-serif",
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                Deny
              </button>
              <button
                onClick={onAllow}
                style={{
                  padding: '8px 20px',
                  borderRadius: 10,
                  border: '1px solid rgba(255,43,68,0.4)',
                  background: 'rgba(255,43,68,0.2)',
                  color: '#ff4466',
                  fontSize: 13, fontWeight: 600,
                  fontFamily: "'Inter', sans-serif",
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                Allow
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
