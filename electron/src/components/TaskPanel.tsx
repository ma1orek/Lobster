import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface TaskRecord {
  id: string;
  task: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  result?: string;
  steps: Array<{ tool: string; label: string; timestamp: number }>;
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

interface ActivityStep {
  icon: string;
  text: string;
  time: number;
  type?: 'action' | 'thought' | 'success' | 'error' | 'info';
}

interface SwarmTask {
  task: string;
  url: string;
  taskId: string;
  status: string;
}

interface ChatMessage {
  type: 'user' | 'agent' | 'action' | 'error' | 'thought' | 'tool_call' | 'task_status' | 'screenshot';
  text: string;
  timestamp: number;
  toolType?: string;
  screenshotBase64?: string;
}

interface TaskPanelProps {
  show: boolean;
  tasks: TaskRecord[];
  cronJobs: Record<string, CronJob>;
  activitySteps?: ActivityStep[];
  swarmTasks?: SwarmTask[];
  agentState?: string;
  chatMessages?: ChatMessage[];
  agentScreenshot?: string | null;
  onClose: () => void;
  onRetryTask: (taskText: string) => void;
  onDeleteTask: (taskId: string) => void;
  onModifyCron: (jobId: string, interval: number) => void;
  onCancelCron: (jobId: string) => void;
  onUpdateCronTask?: (jobId: string, newTask: string) => void;
  sendTextCommand?: (text: string) => void;
  initialTab?: 'chat' | 'tasks';
}

const STATUS_COLORS: Record<string, string> = {
  running: 'rgba(160,170,255,0.7)',
  done: 'rgba(130,210,160,0.6)',
  error: 'rgba(220,120,120,0.6)',
  cancelled: 'rgba(160,165,180,0.4)',
};

const STATUS_LABELS: Record<string, string> = {
  running: 'Running',
  done: 'Done',
  error: 'Error',
  cancelled: 'Cancelled',
};

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── SVG icon components (12×12 stroke-based) ──────────────────
const IconRefresh = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);
const IconPencil = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
  </svg>
);
const IconX = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);
const IconStop = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor" fillOpacity="0.15" />
  </svg>
);
const IconPlus = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);
const IconClock = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
  </svg>
);
const IconCheck = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const CAPABILITIES = [
  {
    label: 'Browse & Navigate',
    icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
    examples: ['Open youtube.com', 'Click "Sign In" button', 'Go back to previous page', 'Switch to the Reddit tab'],
  },
  {
    label: 'Search & Research',
    icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
    examples: ['Search for best laptops 2026', 'Find cheapest flights to Paris', 'Compare React vs Vue frameworks'],
  },
  {
    label: 'Fill Forms & Type',
    icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M8 8h8M8 12h6"/></svg>,
    examples: ['Write a comment on this post', 'Fill in the contact form', 'Compose an email to John'],
  },
  {
    label: 'Draw & Design',
    icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/></svg>,
    examples: ['Draw a cat on Excalidraw', 'Sketch a flowchart diagram', 'Design a UI wireframe'],
  },
  {
    label: 'Monitor & Track',
    icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
    examples: ['Check Reddit /r/tech every 60s', 'Monitor stock price of AAPL', 'Track new posts and comment on them'],
  },
  {
    label: 'Read & Summarize',
    icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>,
    examples: ['Summarize this article', 'Extract all prices from this page', 'What does this page say about AI?'],
  },
];

const btnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 5, padding: '3px 7px',
  cursor: 'pointer', fontSize: 10, lineHeight: 1,
  color: 'rgba(255,255,255,0.5)',
  transition: 'all 0.15s',
  display: 'inline-flex', alignItems: 'center', gap: 3,
};

const iconBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 5, padding: '4px 5px',
  cursor: 'pointer', lineHeight: 0,
  color: 'rgba(255,255,255,0.45)',
  transition: 'all 0.15s',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
};

export default function TaskPanel({ show, tasks, cronJobs, activitySteps = [], swarmTasks = [], agentState = 'idle', chatMessages = [], agentScreenshot, onClose, onRetryTask, onDeleteTask, onModifyCron, onCancelCron, onUpdateCronTask, sendTextCommand, initialTab }: TaskPanelProps) {
  const [activeTab, setActiveTab] = useState<'chat' | 'tasks'>(initialTab || 'chat');
  const [chatInput, setChatInput] = useState('');
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [newTaskText, setNewTaskText] = useState('');
  const [showNewTask, setShowNewTask] = useState(false);
  const [editingCronField, setEditingCronField] = useState<{ jobId: string; field: 'interval' | 'task' } | null>(null);
  const [cronEditValue, setCronEditValue] = useState('');
  const [expandedCap, setExpandedCap] = useState<number | null>(null);
  const newTaskRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const cronEditRef = useRef<HTMLInputElement>(null);
  const activityScrollRef = useRef<HTMLDivElement | null>(null);

  const sortedTasks = [...tasks].reverse();

  // Auto-scroll chat when new activity arrives
  useEffect(() => {
    if (chatScrollRef.current && activeTab === 'chat') {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [activitySteps.length]);

  // Auto-scroll chat
  useEffect(() => {
    if (chatScrollRef.current && activeTab === 'chat') {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages.length, activeTab]);

  // Respond to external tab switch (e.g., chat button toggles to chat tab)
  useEffect(() => {
    if (initialTab && show) setActiveTab(initialTab);
  }, [initialTab, show]);

  // Auto-scroll chat when agent starts working
  useEffect(() => {
    if ((agentState === 'thinking' || agentState === 'acting') && chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [agentState]);

  useEffect(() => {
    if (showNewTask && newTaskRef.current) newTaskRef.current.focus();
  }, [showNewTask]);

  useEffect(() => {
    if (editingId && editRef.current) editRef.current.focus();
  }, [editingId]);

  useEffect(() => {
    if (editingCronField && cronEditRef.current) cronEditRef.current.focus();
  }, [editingCronField]);

  const handleRetry = (e: React.MouseEvent, taskText: string) => {
    e.stopPropagation();
    onRetryTask(taskText);
  };

  const handleStartEdit = (e: React.MouseEvent, task: TaskRecord) => {
    e.stopPropagation();
    setEditingId(task.id);
    setEditText(task.task);
  };

  const handleSubmitEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editText.trim()) {
      onRetryTask(editText.trim());
      setEditingId(null);
      setEditText('');
    }
  };

  const handleDelete = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation();
    onDeleteTask(taskId);
  };

  const handleNewTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (newTaskText.trim()) {
      onRetryTask(newTaskText.trim());
      setNewTaskText('');
      setShowNewTask(false);
    }
  };

  const startCronEdit = (jobId: string, field: 'interval' | 'task', currentValue: string) => {
    setEditingCronField({ jobId, field });
    setCronEditValue(currentValue);
  };

  const submitCronEdit = () => {
    if (!editingCronField) return;
    const { jobId, field } = editingCronField;
    if (field === 'interval') {
      const val = parseInt(cronEditValue, 10);
      if (val && val >= 10) {
        onModifyCron(jobId, val);
      }
    } else if (field === 'task') {
      if (cronEditValue.trim() && onUpdateCronTask) {
        onUpdateCronTask(jobId, cronEditValue.trim());
      }
    }
    setEditingCronField(null);
  };

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key="task-panel"
          initial={{ x: 350, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 350, opacity: 0 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          style={{
            position: 'fixed',
            top: 84, right: 0,
            width: 340,
            bottom: 0,
            background: 'linear-gradient(180deg, rgba(14,14,18,0.97) 0%, rgba(10,10,14,0.98) 100%)',
            backdropFilter: 'blur(24px)',
            borderLeft: '1px solid rgba(255,255,255,0.06)',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            fontFamily: "'Inter', system-ui, sans-serif",
          }}
        >
          {/* Header — minimal */}
          <div style={{
            padding: '8px 12px',
            borderBottom: '1px solid rgba(255,255,255,0.05)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div style={{ display: 'flex', gap: 2 }}>
              {(['chat', 'tasks'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  style={{
                    padding: '4px 10px',
                    fontSize: 11, fontWeight: 500,
                    color: activeTab === tab ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.3)',
                    background: activeTab === tab ? 'rgba(255,255,255,0.06)' : 'transparent',
                    border: 'none',
                    borderRadius: 6,
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    fontFamily: 'inherit',
                    letterSpacing: '0.01em',
                    position: 'relative',
                  }}
                >
                  {tab === 'chat' ? 'Chat' : 'Tasks'}
                  {tab === 'chat' && (agentState === 'thinking' || agentState === 'acting') && (
                    <span style={{
                      position: 'absolute', top: 2, right: 2,
                      width: 4, height: 4, borderRadius: '50%',
                      background: '#FF2B44',
                      animation: 'task-panel-dot 1.5s ease-in-out infinite',
                    }} />
                  )}
                  {tab === 'tasks' && tasks.filter(t => t.status === 'running').length > 0 && (
                    <span style={{
                      marginLeft: 3, fontSize: 9, fontWeight: 700, color: '#818cf8',
                    }}>
                      {tasks.filter(t => t.status === 'running').length}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 3 }}>
              {activeTab === 'tasks' && (
                <button
                  onClick={() => setShowNewTask(v => !v)}
                  style={{
                    ...btnStyle,
                    background: showNewTask ? 'rgba(129,140,248,0.12)' : 'transparent',
                    border: showNewTask ? '1px solid rgba(129,140,248,0.2)' : '1px solid rgba(255,255,255,0.05)',
                    color: showNewTask ? 'rgba(160,170,255,0.8)' : 'rgba(255,255,255,0.4)',
                    fontWeight: 500, gap: 3,
                  }}
                >
                  <IconPlus /> New
                </button>
              )}
              <button
                onClick={onClose}
                style={{
                  background: 'none', border: 'none',
                  width: 22, height: 22, borderRadius: 5,
                  cursor: 'pointer', lineHeight: 0,
                  color: 'rgba(255,255,255,0.25)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'color 0.15s',
                }}
              >
                <IconX />
              </button>
            </div>
          </div>

          <style>{`
            @keyframes task-panel-dot {
              0%, 100% { opacity: 1; }
              50% { opacity: 0.3; }
            }
            @keyframes pulse-dot {
              0%, 100% { opacity: 1; transform: scale(1); }
              50% { opacity: 0.4; transform: scale(0.7); }
            }
          `}</style>

          {/* ── CHAT TAB ── */}
          {activeTab === 'chat' && (
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              {/* Live agent screenshot — single updating view */}
              {agentScreenshot && (
                <div style={{ padding: '8px 12px 4px', flexShrink: 0 }}>
                  <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', marginBottom: 3, letterSpacing: '0.05em', textTransform: 'uppercase' as const }}>Agent view</div>
                  <img
                    src={`data:image/jpeg;base64,${agentScreenshot}`}
                    style={{
                      width: '100%', borderRadius: 8,
                      border: '1px solid rgba(255,255,255,0.08)',
                      opacity: 0.9,
                    }}
                  />
                </div>
              )}
              {/* Chat messages — preprocessed to collapse spam */}
              <div
                ref={chatScrollRef}
                style={{
                  flex: 1, overflowY: 'auto', padding: '10px 12px',
                  display: 'flex', flexDirection: 'column', gap: 4,
                }}
              >
                {chatMessages.length === 0 ? (
                  <div style={{
                    color: 'rgba(255,255,255,0.2)', fontSize: 12, textAlign: 'center',
                    padding: '40px 16px', lineHeight: 1.6,
                  }}>
                    Chat with Lobster here.<br/>
                    <span style={{ fontSize: 10, opacity: 0.6 }}>Type a message or use voice.</span>
                  </div>
                ) : (() => {
                  // Preprocess: group consecutive tool_calls/actions into collapsed entries
                  type DisplayItem = { kind: 'msg'; msg: ChatMessage; idx: number }
                    | { kind: 'actions'; msgs: ChatMessage[]; startIdx: number };
                  const items: DisplayItem[] = [];
                  let actionBuffer: ChatMessage[] = [];
                  let bufStart = 0;

                  const flushActions = () => {
                    if (actionBuffer.length > 0) {
                      items.push({ kind: 'actions', msgs: [...actionBuffer], startIdx: bufStart });
                      actionBuffer = [];
                    }
                  };

                  chatMessages.forEach((msg, i) => {
                    const isActionLike = msg.type === 'tool_call' || msg.type === 'action';
                    if (isActionLike) {
                      if (actionBuffer.length === 0) bufStart = i;
                      actionBuffer.push(msg);
                    } else {
                      flushActions();
                      items.push({ kind: 'msg', msg, idx: i });
                    }
                  });
                  flushActions();

                  return items.map((item, di) => {
                    // ── Collapsed action group (tool_calls + actions) ──
                    if (item.kind === 'actions') {
                      const group = item.msgs;
                      const last = group[group.length - 1];
                      // Show only the last action as a single compact line with count
                      return (
                        <div key={`ag-${item.startIdx}`} style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          padding: '3px 8px',
                          opacity: 0.55,
                        }}>
                          <svg width="9" height="9" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
                            <path d="M6 1v10M6 1L3 4M6 1l3 3" stroke="rgba(160,170,255,0.5)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                          <span style={{
                            flex: 1, fontSize: 10, color: 'rgba(255,255,255,0.45)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {last.text}
                          </span>
                          {group.length > 1 && (
                            <span style={{
                              fontSize: 9, color: 'rgba(160,170,255,0.4)', flexShrink: 0,
                              background: 'rgba(160,170,255,0.08)', borderRadius: 4,
                              padding: '1px 4px',
                            }}>
                              +{group.length - 1}
                            </span>
                          )}
                        </div>
                      );
                    }

                    const msg = item.msg;

                    // ── Thought (compact italic) ──
                    if (msg.type === 'thought') {
                      return (
                        <div key={item.idx} style={{
                          padding: '4px 8px', marginLeft: 4,
                          borderLeft: '2px solid rgba(255,200,50,0.2)',
                        }}>
                          <div style={{
                            fontSize: 10.5, lineHeight: 1.45,
                            color: 'rgba(255,255,255,0.35)',
                            fontStyle: 'italic',
                            wordBreak: 'break-word',
                            display: '-webkit-box',
                            WebkitLineClamp: 3,
                            WebkitBoxOrient: 'vertical' as const,
                            overflow: 'hidden',
                          }}>
                            {msg.text}
                          </div>
                        </div>
                      );
                    }

                    // ── Task status (running/done/error) ──
                    if (msg.type === 'task_status') {
                      const isDone = msg.toolType === 'done';
                      const isRunning = msg.toolType === 'running';
                      const dotColor = isDone ? 'rgba(130,210,160,0.6)' : isRunning ? 'rgba(160,170,255,0.7)' : 'rgba(220,120,120,0.6)';
                      const bgColor = isDone ? 'rgba(130,210,160,0.05)' : isRunning ? 'rgba(160,170,255,0.05)' : 'rgba(220,120,120,0.05)';
                      return (
                        <div key={item.idx} style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          padding: '5px 8px',
                          background: bgColor,
                          borderRadius: 8,
                        }}>
                          <div style={{
                            width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                            background: dotColor,
                            ...(isRunning ? { animation: 'pulse-dot 1.5s ease-in-out infinite' } : {}),
                          }} />
                          <span style={{
                            flex: 1, fontSize: 11, color: 'rgba(255,255,255,0.6)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {msg.text}
                          </span>
                        </div>
                      );
                    }

                    // ── Error ──
                    if (msg.type === 'error') {
                      return (
                        <div key={item.idx} style={{
                          padding: '6px 10px',
                          background: 'rgba(220,60,60,0.08)',
                          borderRadius: 10,
                          fontSize: 11.5, color: 'rgba(220,120,120,0.8)',
                          lineHeight: 1.45, wordBreak: 'break-word',
                        }}>
                          {msg.text}
                        </div>
                      );
                    }

                    // ── User / Agent messages ──
                    const isUser = msg.type === 'user';
                    return (
                      <div key={item.idx} style={{
                        display: 'flex',
                        justifyContent: isUser ? 'flex-end' : 'flex-start',
                      }}>
                        <div style={{
                          maxWidth: '88%',
                          padding: '7px 11px',
                          borderRadius: isUser ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
                          background: isUser
                            ? 'rgba(255,43,68,0.14)'
                            : 'rgba(255,255,255,0.04)',
                          border: isUser
                            ? '1px solid rgba(255,43,68,0.15)'
                            : '1px solid rgba(255,255,255,0.05)',
                        }}>
                          <div style={{
                            fontSize: 12, lineHeight: 1.5,
                            color: isUser ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.75)',
                            wordBreak: 'break-word',
                          }}>
                            {msg.text}
                          </div>
                          <div style={{
                            fontSize: 9, color: 'rgba(255,255,255,0.15)', marginTop: 3,
                            textAlign: isUser ? 'right' : 'left',
                          }}>
                            {formatTime(msg.timestamp)}
                          </div>
                        </div>
                      </div>
                    );
                  });
                })()}
                {/* Typing indicator */}
                {(agentState === 'thinking' || agentState === 'speaking') && (
                  <div style={{ display: 'flex', gap: 4, padding: '4px 0' }}>
                    <motion.div animate={{ opacity: [0.2, 0.8, 0.2] }} transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
                      style={{ width: 5, height: 5, borderRadius: '50%', background: '#FF2B44' }} />
                    <motion.div animate={{ opacity: [0.2, 0.8, 0.2] }} transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut', delay: 0.2 }}
                      style={{ width: 5, height: 5, borderRadius: '50%', background: '#FF2B44' }} />
                    <motion.div animate={{ opacity: [0.2, 0.8, 0.2] }} transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut', delay: 0.4 }}
                      style={{ width: 5, height: 5, borderRadius: '50%', background: '#FF2B44' }} />
                  </div>
                )}
              </div>
              {/* Chat input */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (chatInput.trim() && sendTextCommand) {
                    sendTextCommand(chatInput.trim());
                    setChatInput('');
                  }
                }}
                style={{
                  padding: '8px 10px',
                  borderTop: '1px solid rgba(255,255,255,0.05)',
                  display: 'flex', gap: 6,
                }}
              >
                <input
                  type="text"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  placeholder="Message Lobster..."
                  style={{
                    flex: 1, background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.07)',
                    borderRadius: 10, padding: '8px 12px',
                    color: '#fff', fontSize: 12,
                    fontFamily: 'inherit',
                    outline: 'none',
                    transition: 'border-color 0.15s',
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = 'rgba(255,43,68,0.3)'; }}
                  onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)'; }}
                />
                <button
                  type="submit"
                  disabled={!chatInput.trim()}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 32, height: 32, borderRadius: 8,
                    border: 'none',
                    background: chatInput.trim() ? 'rgba(255,43,68,0.2)' : 'rgba(255,255,255,0.03)',
                    color: chatInput.trim() ? 'rgba(255,43,68,0.85)' : 'rgba(255,255,255,0.15)',
                    cursor: chatInput.trim() ? 'pointer' : 'default',
                    flexShrink: 0, transition: 'all 0.15s',
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                </button>
              </form>
            </div>
          )}


          {/* ── TASKS TAB ── */}
          {activeTab === 'tasks' && (<>

          {/* New Task Input */}
          <AnimatePresence>
            {showNewTask && (
              <motion.form
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.15 }}
                onSubmit={handleNewTask}
                style={{ overflow: 'hidden', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
              >
                <div style={{ padding: '10px 14px', display: 'flex', gap: 6 }}>
                  <input
                    ref={newTaskRef}
                    value={newTaskText}
                    onChange={e => setNewTaskText(e.target.value)}
                    placeholder="Describe task... (e.g. open youtube)"
                    style={{
                      flex: 1, background: 'rgba(255,255,255,0.05)',
                      border: '1px solid rgba(129,140,248,0.25)',
                      borderRadius: 6, padding: '6px 10px',
                      color: 'rgba(255,255,255,0.85)', fontSize: 11,
                      outline: 'none', fontFamily: 'inherit',
                    }}
                    onKeyDown={e => e.key === 'Escape' && setShowNewTask(false)}
                  />
                  <button
                    type="submit"
                    style={{
                      ...btnStyle,
                      background: 'rgba(129,140,248,0.15)',
                      border: '1px solid rgba(129,140,248,0.3)',
                      color: 'rgba(160,170,255,0.9)',
                      padding: '6px 10px',
                    }}
                  >
                    Send
                  </button>
                </div>
              </motion.form>
            )}
          </AnimatePresence>

          {/* Active Cron Jobs */}
          {Object.keys(cronJobs).length > 0 && (
            <div style={{
              padding: '8px 14px',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
            }}>
              <div style={{
                fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.35)',
                letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6,
              }}>
                Recurring Tasks
              </div>
              {Object.entries(cronJobs).map(([jobId, job]) => {
                const isEditingInterval = editingCronField?.jobId === jobId && editingCronField.field === 'interval';
                const isEditingTask = editingCronField?.jobId === jobId && editingCronField.field === 'task';

                return (
                  <div key={jobId} style={{
                    background: 'rgba(129,140,248,0.06)',
                    border: '1px solid rgba(129,140,248,0.15)',
                    borderRadius: 8, padding: '8px 10px', marginBottom: 4,
                  }}>
                    {/* Task description — click to edit inline */}
                    {isEditingTask ? (
                      <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
                        <input
                          ref={cronEditRef}
                          value={cronEditValue}
                          onChange={e => setCronEditValue(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') submitCronEdit();
                            if (e.key === 'Escape') setEditingCronField(null);
                          }}
                          style={{
                            flex: 1, background: 'rgba(255,255,255,0.08)',
                            border: '1px solid rgba(129,140,248,0.3)',
                            borderRadius: 4, padding: '3px 6px',
                            color: 'rgba(255,255,255,0.85)', fontSize: 11,
                            outline: 'none', fontFamily: 'inherit',
                          }}
                        />
                        <button onClick={submitCronEdit} style={{ ...iconBtnStyle, color: 'rgba(130,210,160,0.8)' }}>
                          <IconCheck />
                        </button>
                        <button onClick={() => setEditingCronField(null)} style={{ ...iconBtnStyle, color: 'rgba(255,255,255,0.3)' }}>
                          <IconX />
                        </button>
                      </div>
                    ) : (
                      <div
                        onClick={() => startCronEdit(jobId, 'task', job.task)}
                        style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', fontWeight: 500, cursor: 'pointer' }}
                        title="Click to edit task description"
                      >
                        {job.task}
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                      {isEditingInterval ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} onClick={e => e.stopPropagation()}>
                          <IconClock />
                          <input
                            ref={!isEditingTask ? cronEditRef : undefined}
                            autoFocus
                            value={cronEditValue}
                            onChange={e => setCronEditValue(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') submitCronEdit();
                              if (e.key === 'Escape') setEditingCronField(null);
                            }}
                            style={{
                              width: 50, background: 'rgba(255,255,255,0.08)',
                              border: '1px solid rgba(129,140,248,0.3)',
                              borderRadius: 4, padding: '2px 5px', textAlign: 'center',
                              color: 'rgba(255,255,255,0.85)', fontSize: 10,
                              outline: 'none', fontFamily: 'inherit',
                            }}
                          />
                          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>s</span>
                          <button onClick={submitCronEdit} style={{ ...iconBtnStyle, padding: '2px 4px', color: 'rgba(130,210,160,0.8)' }}>
                            <IconCheck />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => startCronEdit(jobId, 'interval', String(job.interval))}
                          style={{ ...btnStyle, fontSize: 9.5, gap: 3 }}
                        >
                          <IconClock /> Every {job.interval}s
                        </button>
                      )}
                      <button
                        onClick={() => startCronEdit(jobId, 'task', job.task)}
                        style={{ ...iconBtnStyle, padding: '3px 4px' }}
                        title="Edit task"
                      >
                        <IconPencil />
                      </button>
                      <button
                        onClick={() => onCancelCron(jobId)}
                        style={{ ...iconBtnStyle, padding: '3px 4px', color: 'rgba(248,113,113,0.7)' }}
                        title="Cancel recurring task"
                      >
                        <IconStop />
                      </button>
                      {job.running && (
                        <motion.span
                          animate={{ opacity: [0.4, 1, 0.4] }}
                          transition={{ duration: 1.2, repeat: Infinity }}
                          style={{ fontSize: 9, color: '#818cf8' }}
                        >
                          Running...
                        </motion.span>
                      )}
                    </div>
                    {job.lastResult && (
                      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginTop: 4, lineHeight: 1.3 }}>
                        {job.lastResult.slice(0, 150)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Capabilities section — expandable on click */}
          <div style={{
            padding: '10px 14px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}>
            <div style={{
              fontSize: 10, fontWeight: 600,
              color: 'rgba(255,255,255,0.35)',
              letterSpacing: '0.06em', textTransform: 'uppercase',
              marginBottom: 6, textAlign: 'left',
            }}>
              What can I do?
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {CAPABILITIES.map((cap, i) => (
                <div key={cap.label}>
                  <button
                    onClick={() => setExpandedCap(expandedCap === i ? null : i)}
                    style={{
                      width: '100%',
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '5px 8px',
                      background: expandedCap === i ? 'rgba(255,255,255,0.04)' : 'transparent',
                      border: 'none', borderRadius: 6,
                      cursor: 'pointer', color: 'rgba(255,255,255,0.5)',
                      fontSize: 10.5, fontFamily: 'inherit',
                      transition: 'background 0.15s',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ flexShrink: 0, opacity: 0.6 }}>{cap.icon}</span>
                    <span style={{ flex: 1 }}>{cap.label}</span>
                    <motion.svg
                      width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                      animate={{ rotate: expandedCap === i ? 180 : 0 }}
                      transition={{ duration: 0.2 }}
                      style={{ flexShrink: 0, opacity: 0.4 }}
                    >
                      <polyline points="2 4 6 8 10 4" />
                    </motion.svg>
                  </button>
                  <AnimatePresence>
                    {expandedCap === i && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        style={{ overflow: 'hidden', paddingLeft: 26 }}
                      >
                        {cap.examples.map((ex, j) => (
                          <div
                            key={j}
                            onClick={() => { onRetryTask(ex); }}
                            style={{
                              padding: '3px 8px',
                              fontSize: 10, color: 'rgba(255,255,255,0.35)',
                              cursor: 'pointer', borderRadius: 4,
                              transition: 'color 0.15s, background 0.15s',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.color = 'rgba(160,170,255,0.8)'; e.currentTarget.style.background = 'rgba(129,140,248,0.08)'; }}
                            onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.35)'; e.currentTarget.style.background = 'transparent'; }}
                            title="Click to run this"
                          >
                            {ex}
                          </div>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              ))}
            </div>
          </div>

          {/* Task list */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            padding: '8px 12px',
            scrollbarWidth: 'thin',
            scrollbarColor: 'rgba(255,255,255,0.08) transparent',
          }}>
            {sortedTasks.length === 0 && (
              <div style={{ textAlign: 'left', padding: '32px 8px', color: 'rgba(255,255,255,0.25)', fontSize: 12, lineHeight: 1.5 }}>
                No tasks yet. Click "+ New Task" or say "Hey, Lobster" to start.
              </div>
            )}
            {sortedTasks.map(task => {
              const isExpanded = expandedId === task.id;
              const isEditing = editingId === task.id;
              const duration = task.finishedAt
                ? formatDuration(task.finishedAt - task.startedAt)
                : formatDuration(Date.now() - task.startedAt);
              const color = STATUS_COLORS[task.status] || '#94a3b8';

              return (
                <motion.div
                  key={task.id}
                  layout
                  onClick={() => { if (!isEditing) setExpandedId(isExpanded ? null : task.id); }}
                  style={{
                    background: isExpanded ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)',
                    border: `1px solid ${isExpanded ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)'}`,
                    borderRadius: 10,
                    padding: '10px 12px',
                    marginBottom: 6,
                    cursor: 'pointer',
                    transition: 'background 0.15s, border-color 0.15s',
                    textAlign: 'left',
                  }}
                >
                  {/* Task header */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ marginTop: 4, flexShrink: 0 }}>
                      {task.status === 'running' ? (
                        <motion.div
                          animate={{ scale: [1, 1.3, 1], opacity: [0.7, 1, 0.7] }}
                          transition={{ duration: 1.2, repeat: Infinity }}
                          style={{ width: 8, height: 8, borderRadius: '50%', background: color }}
                        />
                      ) : (
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, opacity: 0.7 }} />
                      )}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.8)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>
                        {task.task}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                        <span style={{ fontSize: 10, color: `${color}cc`, fontWeight: 600 }}>
                          {STATUS_LABELS[task.status]}
                        </span>
                        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>
                          {formatTime(task.startedAt)}
                        </span>
                        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>
                          {duration}
                        </span>
                        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)' }}>
                          {task.steps.length} step{task.steps.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                    </div>
                    {/* Action buttons — SVG icons, not emoji */}
                    <div style={{ display: 'flex', gap: 3, flexShrink: 0, marginTop: 2 }}>
                      {task.status === 'running' ? (
                        <button
                          onClick={(e) => handleDelete(e, task.id)}
                          title="Cancel task"
                          style={{ ...iconBtnStyle, color: 'rgba(220,120,120,0.6)' }}
                        >
                          <IconStop />
                        </button>
                      ) : (
                        <>
                          <button onClick={(e) => handleRetry(e, task.task)} title="Retry" style={iconBtnStyle}>
                            <IconRefresh />
                          </button>
                          <button onClick={(e) => handleStartEdit(e, task)} title="Edit & retry" style={iconBtnStyle}>
                            <IconPencil />
                          </button>
                          <button onClick={(e) => handleDelete(e, task.id)} title="Delete" style={{ ...iconBtnStyle, color: 'rgba(220,120,120,0.4)' }}>
                            <IconX />
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Inline edit */}
                  {isEditing && (
                    <form onSubmit={handleSubmitEdit} style={{ marginTop: 6, display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
                      <input
                        ref={editRef}
                        value={editText}
                        onChange={e => setEditText(e.target.value)}
                        onKeyDown={e => e.key === 'Escape' && setEditingId(null)}
                        style={{
                          flex: 1, background: 'rgba(255,255,255,0.06)',
                          border: '1px solid rgba(129,140,248,0.3)',
                          borderRadius: 5, padding: '4px 8px',
                          color: 'rgba(255,255,255,0.85)', fontSize: 11,
                          outline: 'none', fontFamily: 'inherit',
                        }}
                      />
                      <button type="submit" style={{
                        ...btnStyle,
                        background: 'rgba(129,140,248,0.15)',
                        border: '1px solid rgba(129,140,248,0.3)',
                        color: 'rgba(160,170,255,0.9)',
                        padding: '4px 8px',
                      }}>
                        Run
                      </button>
                    </form>
                  )}

                  {/* Expanded: step history + result */}
                  <AnimatePresence>
                    {isExpanded && !isEditing && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        style={{ overflow: 'hidden', marginTop: 8 }}
                      >
                        {task.steps.length > 0 && (
                          <div style={{
                            borderTop: '1px solid rgba(255,255,255,0.04)',
                            paddingTop: 6,
                          }}>
                            {task.steps.slice(-12).map((step, i) => (
                              <div key={i} style={{
                                display: 'flex', alignItems: step.tool === 'thought' ? 'flex-start' : 'center', gap: 6,
                                padding: step.tool === 'thought' ? '3px 0' : '2px 0',
                                fontSize: step.tool === 'thought' ? 10 : 10.5,
                              }}>
                                {step.tool === 'thought' ? (
                                  <>
                                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginTop: 1.5, opacity: 0.4 }}>
                                      <circle cx="8" cy="6" r="5" stroke="rgba(255,200,50,0.8)" strokeWidth="1.3" fill="none"/>
                                      <path d="M6 11.5h4M6.5 13h3" stroke="rgba(255,200,50,0.6)" strokeWidth="1" strokeLinecap="round"/>
                                    </svg>
                                    <span style={{
                                      color: 'rgba(255,220,100,0.55)', flex: 1,
                                      fontStyle: 'italic', lineHeight: '1.35',
                                      overflow: 'hidden', display: '-webkit-box',
                                      WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                                    }}>
                                      {step.label}
                                    </span>
                                  </>
                                ) : (
                                  <>
                                    <span style={{ color: 'rgba(255,255,255,0.2)', width: 14, textAlign: 'right', flexShrink: 0 }}>
                                      {i + 1}
                                    </span>
                                    <span style={{ color: 'rgba(255,255,255,0.5)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {step.label}
                                    </span>
                                  </>
                                )}
                              </div>
                            ))}
                            {task.steps.length > 10 && (
                              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', paddingLeft: 20, marginTop: 2 }}>
                                +{task.steps.length - 10} more steps
                              </div>
                            )}
                          </div>
                        )}
                        {task.result && (
                          <div style={{
                            marginTop: 6, padding: '6px 8px',
                            background: 'rgba(255,255,255,0.02)',
                            borderRadius: 6,
                            fontSize: 10.5, color: 'rgba(255,255,255,0.5)',
                            lineHeight: 1.4,
                            maxHeight: 100, overflowY: 'auto',
                            textAlign: 'left',
                          }}>
                            {task.result.slice(0, 500)}
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </div>
          </>)}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
