import React, { useEffect, useState, useRef } from 'react';

export interface CometStep {
  icon: string;
  text: string;
  time: number;
  type?: 'action' | 'thought' | 'success' | 'error' | 'info';
}

interface CometOverlayProps {
  steps: CometStep[];
  agentState: string;
  swarmTasks?: { task: string; url: string; taskId: string; status: string }[];
}

const CometOverlay: React.FC<CometOverlayProps> = ({
  steps,
  agentState,
  swarmTasks,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [visible, setVisible] = useState(false);
  const fadeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const isActive = agentState === 'thinking' || agentState === 'acting' || agentState === 'speaking';

  useEffect(() => {
    if (isActive && (steps.length > 0 || (swarmTasks && swarmTasks.length > 0))) {
      setVisible(true);
      setExpanded(true);
      if (fadeTimeout.current) clearTimeout(fadeTimeout.current);
    } else if (!isActive && visible) {
      fadeTimeout.current = setTimeout(() => {
        setExpanded(false);
        fadeTimeout.current = setTimeout(() => setVisible(false), 8000);
      }, 5000);
    }
    return () => { if (fadeTimeout.current) clearTimeout(fadeTimeout.current); };
  }, [agentState, steps.length, swarmTasks]);

  // Auto-scroll to bottom when new steps arrive
  useEffect(() => {
    if (scrollRef.current && expanded) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [steps.length, expanded]);

  if (!visible && steps.length === 0) return null;

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
  };

  const stepColor = (type?: string) => {
    switch (type) {
      case 'success': return '#4CAF50';
      case 'error': return '#f44336';
      case 'thought': return 'rgba(255,255,255,0.4)';
      case 'info': return '#64B5F6';
      default: return 'rgba(255,255,255,0.65)';
    }
  };

  // Collapsed: small animated indicator bubble
  if (!expanded) {
    return (
      <div
        onClick={() => { setExpanded(true); setVisible(true); }}
        style={{
          position: 'fixed',
          bottom: 20,
          right: 20,
          width: 44,
          height: 44,
          borderRadius: 22,
          background: 'rgba(16, 16, 20, 0.9)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          border: `1px solid ${isActive ? 'rgba(183,13,17,0.5)' : 'rgba(255,255,255,0.1)'}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          zIndex: 9999,
          boxShadow: isActive
            ? '0 0 20px rgba(183,13,17,0.2), 0 2px 12px rgba(0,0,0,0.4)'
            : '0 2px 12px rgba(0,0,0,0.3)',
          transition: 'all 0.3s ease',
          fontFamily: "'Inter', -apple-system, sans-serif",
        }}
      >
        {isActive ? (
          <div style={{
            width: 12, height: 12, borderRadius: '50%',
            background: '#FF2B44',
            boxShadow: '0 0 10px rgba(255,43,68,0.5)',
            animation: 'comet-pulse 1.5s ease-in-out infinite',
          }} />
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2" strokeLinecap="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        )}
        {steps.length > 0 && (
          <div style={{
            position: 'absolute', top: -4, right: -4,
            background: '#FF2B44', color: '#fff',
            fontSize: 9, fontWeight: 700,
            width: 18, height: 18, borderRadius: 9,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {steps.length > 99 ? '99+' : steps.length}
          </div>
        )}
        <style>{`
          @keyframes comet-pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.4; transform: scale(0.85); }
          }
        `}</style>
      </div>
    );
  }

  // Expanded: chat-like step log panel
  return (
    <div style={{
      position: 'fixed',
      bottom: 20,
      right: 20,
      width: 360,
      maxHeight: 420,
      background: 'rgba(12, 12, 16, 0.92)',
      backdropFilter: 'blur(24px)',
      WebkitBackdropFilter: 'blur(24px)',
      border: '1px solid rgba(183, 13, 17, 0.3)',
      borderRadius: 16,
      zIndex: 9999,
      boxShadow: '0 0 40px rgba(183,13,17,0.1), 0 8px 32px rgba(0,0,0,0.5)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      fontFamily: "'Inter', -apple-system, sans-serif",
      transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 14px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: isActive ? '#FF2B44' : '#555',
            boxShadow: isActive ? '0 0 8px rgba(255,43,68,0.5)' : 'none',
            animation: isActive ? 'comet-pulse 1.5s ease-in-out infinite' : 'none',
          }} />
          <span style={{
            color: 'rgba(255,255,255,0.5)', fontSize: 10, fontWeight: 600,
            letterSpacing: '0.08em', textTransform: 'uppercase',
          }}>
            Lobster Activity
          </span>
          {isActive && (
            <span style={{
              color: 'rgba(255,255,255,0.25)', fontSize: 9,
              padding: '1px 6px', borderRadius: 4,
              background: 'rgba(255,255,255,0.05)',
            }}>
              {agentState === 'thinking' ? 'WORKING' : agentState === 'speaking' ? 'SPEAKING' : 'PROCESSING'}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {/* Clear button */}
          <div
            onClick={(e) => { e.stopPropagation(); /* parent clears steps */ }}
            style={{
              color: 'rgba(255,255,255,0.2)', fontSize: 11, cursor: 'pointer',
              width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 6, transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
          </div>
          {/* Collapse button */}
          <div
            onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
            style={{
              color: 'rgba(255,255,255,0.3)', fontSize: 16, cursor: 'pointer',
              width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 6, transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            {'\u2212'}
          </div>
        </div>
      </div>

      {/* Swarm section */}
      {swarmTasks && swarmTasks.length > 0 && (
        <div style={{
          padding: '8px 14px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          flexShrink: 0,
        }}>
          <div style={{
            color: 'rgba(255,255,255,0.35)', fontSize: 9, fontWeight: 600,
            letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4,
          }}>
            SWARM ({swarmTasks.length} agents)
          </div>
          {swarmTasks.map((st, i) => (
            <div key={st.taskId || i} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '2px 0',
            }}>
              <div style={{
                width: 5, height: 5, borderRadius: '50%',
                background: st.status === 'done' ? '#4CAF50' : st.status === 'error' ? '#f44336' : '#FFB300',
                flexShrink: 0,
              }} />
              <span style={{
                color: 'rgba(255,255,255,0.45)', fontSize: 10,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {st.task.length > 45 ? st.task.slice(0, 45) + '...' : st.task}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Step log — scrollable chat */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 14px',
          maxHeight: 300,
        }}
      >
        {steps.length === 0 ? (
          <div style={{ color: 'rgba(255,255,255,0.2)', fontSize: 11, textAlign: 'center', padding: '20px 0' }}>
            Waiting for agent activity...
          </div>
        ) : (
          steps.slice(-50).map((step, i) => (
            <div key={i} style={{
              display: 'flex', gap: 8, padding: '4px 0',
              alignItems: 'flex-start',
              animation: i === steps.slice(-50).length - 1 ? 'comet-fadein 0.3s ease' : 'none',
            }}>
              <span style={{ fontSize: 12, flexShrink: 0, lineHeight: '18px', width: 18, textAlign: 'center' }}>
                {step.icon}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{
                  color: stepColor(step.type),
                  fontSize: 11,
                  lineHeight: '18px',
                  wordBreak: 'break-word',
                }}>
                  {step.text}
                </span>
              </div>
              <span style={{
                color: 'rgba(255,255,255,0.15)', fontSize: 9,
                flexShrink: 0, lineHeight: '18px',
              }}>
                {formatTime(step.time)}
              </span>
            </div>
          ))
        )}
      </div>

      <style>{`
        @keyframes comet-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.85); }
        }
        @keyframes comet-fadein {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        div::-webkit-scrollbar { width: 4px; }
        div::-webkit-scrollbar-track { background: transparent; }
        div::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
        div::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
      `}</style>
    </div>
  );
};

export default CometOverlay;
