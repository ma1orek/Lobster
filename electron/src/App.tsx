import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import TabBar from './components/TabBar';
import VoiceOrb from './components/VoiceOrb';
import MessageOverlay from './components/MessageOverlay';
import Aurora from './components/Aurora';
import LobsterLogo from './components/LobsterLogo';
import FindBar from './components/FindBar';
import CommandPalette from './components/CommandPalette';
import ConfirmModal from './components/ConfirmModal';
import TaskPanel from './components/TaskPanel';
import CometOverlay, { CometStep } from './components/CometOverlay';

interface Tab {
  id: number;
  url: string;
  title: string;
  active: boolean;
  isAgent?: boolean;
  isPrivate?: boolean;
}

type AgentState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'acting';

interface LogEntry {
  type: 'user' | 'agent' | 'action' | 'error' | 'thought' | 'tool_call' | 'task_status' | 'screenshot';
  text: string;
  timestamp: number;
  toolType?: string;
  screenshotBase64?: string;
}

// Fixed 2-row chrome: 40px tabs + 44px URL = 84px — NEVER changes dynamically
const CHROME_H = 84;

// ── Window control buttons (frame: false) — Chrome-style ──────
const winBtnBase: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 46, height: 32, borderRadius: 0, border: 'none',
  background: 'transparent', cursor: 'pointer', padding: 0,
  color: 'rgba(255,255,255,0.55)', fontSize: 13, fontWeight: 400,
  transition: 'background 0.12s, color 0.12s',
  fontFamily: 'system-ui, sans-serif',
};

function WindowControls() {
  const [isMax, setIsMax] = useState(false);
  useEffect(() => {
    window.pulse.isMaximized().then(setIsMax);
    window.pulse.onMaximizeChanged(setIsMax);
  }, []);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, flexShrink: 0, height: '100%' }}>
      <button
        onClick={() => window.pulse.windowMinimize()}
        title="Minimize"
        style={winBtnBase}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0" y="4.5" width="10" height="1" fill="currentColor"/></svg>
      </button>
      <button
        onClick={() => window.pulse.windowMaximize()}
        title={isMax ? "Restore" : "Maximize"}
        style={winBtnBase}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
      >
        {isMax ? (
          /* Restore icon — two overlapping rectangles */
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="2" y="0" width="8" height="8" rx="0" stroke="currentColor" strokeWidth="1" fill="none"/>
            <rect x="0" y="2" width="8" height="8" rx="0" stroke="currentColor" strokeWidth="1" fill="rgba(10,10,14,1)"/>
          </svg>
        ) : (
          /* Maximize icon — single rectangle */
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10" rx="0" stroke="currentColor" strokeWidth="1" fill="none"/></svg>
        )}
      </button>
      <button
        onClick={() => window.pulse.windowClose()}
        title="Close"
        style={{ ...winBtnBase, borderRadius: '0 0 0 0' }}
        onMouseEnter={e => { e.currentTarget.style.background = '#e81123'; e.currentTarget.style.color = '#fff'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.55)'; }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0l-10 10" stroke="currentColor" strokeWidth="1.1"/></svg>
      </button>
    </div>
  );
}

// State colors and labels for agent status
const stateColors: Record<string, string> = {
  listening: '#4ade80',
  thinking: '#facc15',
  speaking: '#ff2b44',
  acting: '#a78bfa',
};
const stateLabels: Record<string, string> = {
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking…',
  speaking: 'Speaking',
  acting: 'Working…',
};
// Tool type → SVG icon (12x12, stroke-based, minimal)
const toolIcons: Record<string, React.ReactElement> = {
  navigate: <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M6 1L3 4M6 1l3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  code: <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 3L1.5 6L4 9M8 3l2.5 3L8 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  click: <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M5 1v4.5l2.5 1.5L5 11V5.5L2.5 4L5 1z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" fill="currentColor" fillOpacity="0.15"/></svg>,
  type: <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="3" width="10" height="6" rx="1" stroke="currentColor" strokeWidth="1"/><path d="M4 6h4M6 5v2" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round"/></svg>,
  key: <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2" y="4" width="8" height="5" rx="1" stroke="currentColor" strokeWidth="1"/><path d="M5 6.5h2" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/></svg>,
  scroll: <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M6 11L4 9M6 11l2-2M6 1L4 3M6 1l2 2" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  draw: <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 10l1.5-3.5L9 1l1 1-5.5 5.5L2 10z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" fill="currentColor" fillOpacity="0.1"/></svg>,
  done: <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5L5 9l4.5-6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>,
};

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [agentState, setAgentState] = useState<AgentState>('idle');
  const [agentLog, setAgentLog] = useState<LogEntry[]>([]);
  const [wsConnected, setWsConnected] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [urlFocused, setUrlFocused] = useState(false);
  const [showAgentLog, setShowAgentLog] = useState(false); // kept for toggle button UI
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [hasDownloads, setHasDownloads] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(-1); // -1 = no active download
  const [showFindBar, setShowFindBar] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [ghostTab, setGhostTab] = useState<{ id: number; url: string; title: string } | null>(null);
  const [isPeeking, setIsPeeking] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ action: string; url: string; requestId: string } | null>(null);
  const [splitTabId, setSplitTabId] = useState<number | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [toolLabel, setToolLabel] = useState<string | null>(null);
  const [toolType, setToolType] = useState<string>('code');
  const [awake, setAwake] = useState(true);
  const [showTaskPanel, setShowTaskPanel] = useState(false);
  const [taskPanelTab, setTaskPanelTab] = useState<'chat' | 'tasks'>('chat');
  const [taskHistory, setTaskHistory] = useState<Array<{
    id: string; task: string; status: 'running' | 'done' | 'error' | 'cancelled';
    startedAt: number; finishedAt?: number; result?: string;
    steps: Array<{ tool: string; label: string; timestamp: number }>;
  }>>([]);
  const [cronJobs, setCronJobs] = useState<Record<string, { task: string; interval: number; lastResult?: string; lastTickTime?: number; currentAction?: string; step?: number; maxSteps?: number; running?: boolean; url?: string }>>({});
  const [agentScreenshot, setAgentScreenshot] = useState<string | null>(null);
  const [splashPhase, setSplashPhase] = useState<'video' | 'fadeout' | 'done'>('video');
  const [splashVideoUrl, setSplashVideoUrl] = useState<string | null>(null);
  // Comet Vision Overlay state — chat-like step log
  const [cometSteps, setCometSteps] = useState<CometStep[]>([]);
  const [swarmTasks, setSwarmTasks] = useState<{ task: string; url: string; taskId: string; status: string }[]>([]);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const speakerMutedRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const activeTabIdRef = useRef<number | null>(null);
  const agentStateRef = useRef<AgentState>('idle');
  const audioCtxRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const audioPlayingRef = useRef(false); // immediate flag — blocks mic to prevent echo loop

  // ── Lifted mic state (shared between all VoiceOrb instances) ──
  const [micMuted, setMicMuted] = useState(false); // false = auto-unmuted for demo
  const [micActive, setMicActive] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const micMutedRef = useRef(false);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micAudioCtxRef = useRef<AudioContext | null>(null);
  const micProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const micAnimFrameRef = useRef<number>(0);
  const screenshotCountRef = useRef<number>(0);

  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);
  useEffect(() => { agentStateRef.current = agentState; }, [agentState]);

  // Resolve splash video path on mount + safety timeout
  useEffect(() => {
    window.pulse.getAssetPath('start.mp4').then(url => {
      if (url) setSplashVideoUrl(url);
      else setSplashPhase('done');
    }).catch(() => setSplashPhase('done'));
    const safety = setTimeout(() => setSplashPhase('done'), 12000);
    return () => clearTimeout(safety);
  }, []);

  // When fadeout phase ends (video faded to black), quickly reveal homepage
  useEffect(() => {
    if (splashPhase !== 'fadeout') return;
    const t = setTimeout(() => setSplashPhase('done'), 800);
    return () => clearTimeout(t);
  }, [splashPhase]);

  // Safety: reset 'acting' state if stuck for >60s with no activity
  useEffect(() => {
    if (agentState !== 'acting') return;
    const timer = setTimeout(() => {
      if (agentStateRef.current === 'acting') {
        console.warn('[safety] Acting state stuck for 60s, forcing idle');
        setAgentState('idle');
        agentStateRef.current = 'idle';
        setToolLabel(null);
      }
    }, 60000);
    return () => clearTimeout(timer);
  }, [agentState]);
  useEffect(() => { speakerMutedRef.current = speakerMuted; }, [speakerMuted]);

  // Tell Electron to shrink WebContentsView when task panel opens/closes
  useEffect(() => {
    window.pulse.setRightPanelWidth(showTaskPanel ? 340 : 0);
  }, [showTaskPanel]);

  // Track downloads + keyboard zoom + keyboard shortcut events
  useEffect(() => {
    window.pulse.onDownloadUpdate((downloads) => {
      const active = downloads.find((d: any) => d.state === 'progressing');
      setHasDownloads(downloads.length > 0);
      setDownloadProgress(active ? active.progress : -1);
    });
    window.pulse.onZoomChanged((zoom: number) => setZoomLevel(zoom));
    // Keyboard shortcut events from main process
    window.pulse.onFocusUrlBar(() => {
      urlInputRef.current?.focus();
      urlInputRef.current?.select();
    });
    window.pulse.onToggleFindInPage(() => setShowFindBar(v => !v));
    window.pulse.onToggleCommandPalette(() => setShowCommandPalette(v => !v));
    window.pulse.onEscapePressed(() => {
      setShowFindBar(false);
      setShowCommandPalette(false);
    });
    // Focus mode
    window.pulse.onFocusModeChanged((fm) => setFocusMode(fm));
    // Split view
    window.pulse.onSplitViewChanged((data) => setSplitTabId(data.splitTabId));
    window.pulse.onToggleSplitView(() => {
      // Toggle split: if already split, close. If not, split with next available tab.
      window.pulse.getSplitTab().then((current) => {
        if (current !== null) {
          window.pulse.setSplitTab(null);
        } else {
          // Find another tab to split with
          window.pulse.getTabs().then((allTabs) => {
            const other = allTabs.find((t: any) => t.id !== activeTabIdRef.current && t.url && t.url !== 'about:blank');
            if (other) window.pulse.setSplitTab(other.id);
          });
        }
      });
    });
    // Action guardrails
    window.pulse.onConfirmAction((data) => setConfirmAction(data));
    // Ghost tab events
    window.pulse.onGhostTabStarted((data) => setGhostTab(data));
    window.pulse.onGhostTabUpdated((data) => setGhostTab(prev => prev ? { ...prev, ...data } : data));
    window.pulse.onGhostTabEnded(() => { setGhostTab(null); setIsPeeking(false); });
    // Bodyguard: paywall detection — log only (disabled auto-routing to prevent infinite loop)
    window.pulse.onPaywallDetected((data) => {
      console.log('[bodyguard] Paywall detected on tab', data.tabId, 'score:', data.score);
    });
  }, []);

  // Update zoom when switching tabs
  useEffect(() => {
    if (activeTabId !== null) {
      window.pulse.getZoom().then(setZoomLevel);
    }
  }, [activeTabId]);

  const userTabs = tabs.filter(t => !t.isAgent);
  const hasTabs = userTabs.length > 0;
  const activeTab = tabs.find(t => t.id === activeTabId);
  const isNewTab = activeTab && (!activeTab.url || activeTab.url === 'about:blank' || activeTab.url.startsWith('data:text/html'));
  // Show start page when user has no tabs (agent tabs don't count) or active tab is blank
  const showStartPage = !hasTabs || isNewTab;

  // Sync URL bar to active tab (only when not focused)
  useEffect(() => {
    if (!urlFocused) {
      const t = tabs.find(t => t.id === activeTabId);
      setUrlInput(t?.url || '');
    }
  }, [activeTabId, tabs, urlFocused]);

  // Add log entry. replace=true updates the last same-type entry (turn-based transcript accumulation)
  const addLog = useCallback((type: LogEntry['type'], text: string, replace?: boolean) => {
    const now = Date.now();
    setAgentLog(prev => {
      if (replace) {
        // Find last entry of same type and REPLACE its text (real-time transcript update)
        for (let i = prev.length - 1; i >= Math.max(0, prev.length - 5); i--) {
          if (prev[i].type === type) {
            const updated = [...prev];
            updated[i] = { ...prev[i], text, timestamp: now };
            return updated;
          }
        }
        // No existing entry — fall through to create new
      }
      return [...prev.slice(-30), { type, text, timestamp: now }];
    });
  }, []);

  // Cancel all queued/playing audio immediately
  const cancelAudio = useCallback(() => {
    activeSourcesRef.current.forEach(src => {
      try { src.stop(); } catch { /* already stopped */ }
    });
    activeSourcesRef.current = [];
    nextPlayTimeRef.current = 0;
    audioPlayingRef.current = false;
  }, []);

  const playAudioChunk = useCallback((buffer: ArrayBuffer) => {
    if (speakerMutedRef.current) return; // speaker muted — drop audio
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext({ sampleRate: 24000 });
    }
    const ctx = audioCtxRef.current;
    const int16 = new Int16Array(buffer);
    if (!int16.length) return;
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
    const ab = ctx.createBuffer(1, f32.length, 24000);
    ab.getChannelData(0).set(f32);
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.connect(ctx.destination);
    const now = ctx.currentTime;
    const t = Math.max(now, nextPlayTimeRef.current);
    src.start(t);
    nextPlayTimeRef.current = t + ab.duration;
    // IMMEDIATELY block mic to prevent echo loop
    audioPlayingRef.current = true;
    // Track active sources for cancellation
    activeSourcesRef.current.push(src);
    src.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== src);
      // Unblock mic when ALL audio finished playing + 200ms buffer (reduced from 600ms for better responsiveness)
      if (activeSourcesRef.current.length === 0) {
        setTimeout(() => {
          if (activeSourcesRef.current.length === 0) {
            audioPlayingRef.current = false;
          }
        }, 200);
      }
    };
  }, []);

  const connectWS = useCallback(() => {
    // Unique session ID per connection — ensures fresh Gemini Live session on reconnect
    const sid = `session_${Date.now()}`;
    const ws = new WebSocket(`ws://localhost:8080/ws/user1/${sid}`);
    ws.onopen = () => { setWsConnected(true); };
    ws.onmessage = async (event) => {
      if (event.data instanceof Blob) {
        const buf = await event.data.arrayBuffer();
        if (buf.byteLength > 0) playAudioChunk(buf);
        return;
      }
      try {
        const msg = JSON.parse(event.data);
        // Keepalive ping/pong — respond immediately, skip further processing
        if (msg.type === 'ping') {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        if (msg.type === 'pong') return;
        if (msg.type === 'action') {
          addLog('action', `${msg.action} ${msg.url || msg.text || ''}`);
          const taskId = msg.task_id; // Multi-tab: route to correct agent tab
          let result: any = { status: 'ok' };
          try {
            if (msg.action === 'navigate') {
              // Navigate — use task_id-aware agent IPC, fall back to regular
              try {
                await window.pulse.agentNavigate(msg.url, taskId);
              } catch {
                await window.pulse.navigate(msg.url);
              }
              result = { status: 'ok', navigated_to: msg.url };
            } else if (msg.action === 'new_tab') {
              try {
                const tab = await window.pulse.agentCreateTab(msg.url || '', taskId);
                result = { status: 'ok', tab_id: tab.id };
              } catch {
                const tab = await window.pulse.createTab(msg.url || '');
                result = { status: 'ok', tab_id: tab.id };
              }
            } else if (msg.action === 'evaluate_gallery') {
              // Execute JS on the gallery tab
              try {
                const res = await window.pulse.executeOnGallery(msg.code || '');
                result = { status: 'ok', result: res };
              } catch (err: any) {
                result = { status: 'error', message: err.message || 'Gallery eval failed' };
              }
            } else if (msg.action === 'close_tab') {
              try {
                await window.pulse.agentCloseTab(taskId);
              } catch {
                if (activeTabIdRef.current) await window.pulse.closeTab(activeTabIdRef.current);
              }
              result = { status: 'ok' };
            } else {
              // All other actions (click, type, scroll, etc.) go to agent tab via execute-action
              const { type: _t, action: actionType, task_id: _tid, ...rest } = msg;
              result = await window.pulse.executeAction({ type: actionType, ...rest, taskId });
            }
          } catch (err: any) {
            result = { status: 'error', message: err.message || 'Action failed' };
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'action_result', ...(taskId ? { task_id: taskId } : {}), ...result }));
          }
        } else if (msg.type === 'input_transcript') {
          // Show what the user said (voice input) — same as typed text
          if (msg.text) {
            addLog('user', msg.text, true); // replace=true — transcript accumulates
            // Instant "thinking" feedback — user sees response within ~200ms of speaking
            if (agentStateRef.current !== 'acting' && agentStateRef.current !== 'speaking') {
              setAgentState('listening');
              agentStateRef.current = 'listening';
            }
          }
        } else if (msg.type === 'transcript') {
          const text = msg.text;
          // Filter out internal status messages and element map dumps
          const isGarbage = !text || text === 'Reconnecting...' || text === 'Lobster ready. Just speak!'
            || /PAGE ELEMENTS|data-lobster|#\d+\s+(BTN|INPUT|LINK|A)\s/i.test(text)
            || /click_by_ref|type_into_ref|execute_js\(/.test(text)
            || /querySelector|getElementById|\.textContent/.test(text);
          if (isGarbage) {
            // Silent — skip internal/garbage text
          } else if (text && !text.startsWith('**') && !text.startsWith('Action:')) {
            // replace=true → update last agent bubble (turn-based accumulation from backend)
            addLog('agent', text, msg.replace === true);
          } else if (text?.startsWith('Action:')) {
            addLog('action', text);
          }
        } else if (msg.type === 'agent_thought') {
          // ReAct reasoning from executor — push to chat + comet step log
          // Frontend safety filter: skip if thought contains raw element map or code patterns
          const thought = msg.thought || '';
          const isCleanThought = msg.task_id && thought.length >= 15
            && !/PAGE ELEMENTS|data-lobster|#\d+\s+(BTN|INPUT|LINK|A)\s/i.test(thought)
            && !/click_by_ref|type_into_ref|execute_js\(|querySelector/.test(thought)
            && !/^\s*[{<_#\[]/.test(thought)
            && /\s/.test(thought);
          if (isCleanThought) {
            // Push to chat as thought card (Copilot-style)
            setAgentLog(prev => [...prev.slice(-60), { type: 'thought' as LogEntry['type'], text: thought, timestamp: Date.now() }]);
            setCometSteps(prev => [...prev.slice(-80), { icon: '\u{1F4AD}', text: thought, time: Date.now(), type: 'thought' }]);
            setTaskHistory(prev => prev.map(t =>
              t.id === msg.task_id
                ? { ...t, steps: [...t.steps, { tool: 'thought', label: thought, timestamp: Date.now() }] }
                : t
            ));
          }
        } else if (msg.type === 'tool_activity') {
          // Show what the Executor is doing in background + chat + comet step log
          const toolIcons: Record<string, string> = {
            navigate: '\u{1F310}', click: '\u{1F5B1}', type: '\u2328', code: '\u{1F4BB}',
            draw: '\u{1F3A8}', scroll: '\u2195', key: '\u2328', done: '\u2714',
            search: '\u{1F50D}', image: '\u{1F5BC}', extract: '\u{1F4CB}',
          };
          setToolLabel(msg.label || msg.tool);
          setToolType(msg.tool_type || 'code');
          setAgentState('acting');
          agentStateRef.current = 'acting';
          // Push to chat as tool_call card
          setAgentLog(prev => [...prev.slice(-60), { type: 'tool_call' as LogEntry['type'], text: msg.label || msg.tool, timestamp: Date.now(), toolType: msg.tool_type || 'code' }]);
          setCometSteps(prev => [...prev.slice(-80), {
            icon: toolIcons[msg.tool_type] || '\u26A1',
            text: msg.label || msg.tool,
            time: Date.now(),
            type: 'action',
          }]);
          if (msg.task_id) {
            setTaskHistory(prev => prev.map(t =>
              t.id === msg.task_id
                ? { ...t, steps: [...t.steps, { tool: msg.tool, label: msg.label || msg.tool, timestamp: Date.now() }] }
                : t
            ));
          }
        } else if (msg.type === 'task_progress') {
          // Executor task lifecycle
          if (msg.status === 'running') {
            setToolLabel(msg.task || 'Working...');
            setAgentState('acting');
            agentStateRef.current = 'acting';
            // Push task start to chat so user sees what agent is working on
            setAgentLog(prev => [...prev.slice(-60), { type: 'task_status' as LogEntry['type'], text: `Starting: ${msg.task || 'Working...'}`, timestamp: Date.now(), toolType: 'running' }]);
            setCometSteps(prev => [...prev.slice(-80), { icon: '\u{1F680}', text: `Task: ${msg.task || 'Starting...'}`, time: Date.now(), type: 'info' }]);
            if (msg.task_id) {
              setTaskHistory(prev => {
                if (prev.find(t => t.id === msg.task_id)) return prev;
                return [...prev, { id: msg.task_id, task: msg.task || '', status: 'running', startedAt: Date.now(), steps: [] }];
              });
            }
          } else if (msg.status === 'step') {
            const stepLabel = msg.action || `Step ${msg.step}`;
            setToolLabel(stepLabel);
            if (msg.tool_type) setToolType(msg.tool_type);
            const toolIcons2: Record<string, string> = {
              navigate: '\u{1F310}', click: '\u{1F5B1}', type: '\u2328', code: '\u{1F4BB}',
              draw: '\u{1F3A8}', scroll: '\u2195', key: '\u2328', done: '\u2714',
            };
            setCometSteps(prev => [...prev.slice(-80), {
              icon: toolIcons2[msg.tool_type] || '\u26A1',
              text: `[${msg.step}/${msg.max_steps || 30}] ${stepLabel}`,
              time: Date.now(),
              type: 'action',
            }]);
            // Steps are pushed by tool_activity handler (as proper objects) — don't duplicate here
          } else if (msg.status === 'done') {
            setToolLabel(null);
            setAgentLog(prev => [...prev.slice(-60), { type: 'task_status' as LogEntry['type'], text: msg.result || 'Task complete', timestamp: Date.now(), toolType: 'done' }]);
            setCometSteps(prev => [...prev.slice(-80), { icon: '\u2705', text: msg.result || 'Task complete', time: Date.now(), type: 'success' }]);
            setAgentState('thinking');
            agentStateRef.current = 'thinking';
            setAgentScreenshot(null); // Clear live view when task ends
            if (msg.task_id) {
              setTaskHistory(prev => prev.map(t =>
                t.id === msg.task_id ? { ...t, status: 'done', finishedAt: Date.now(), result: msg.result } : t
              ));
            }
          } else if (msg.status === 'error') {
            addLog('error', msg.error || 'Task failed');
            setToolLabel(null);
            setCometSteps(prev => [...prev.slice(-80), { icon: '\u274C', text: msg.error || 'Task failed', time: Date.now(), type: 'error' }]);
            setAgentState('idle');
            agentStateRef.current = 'idle';
            if (msg.task_id) {
              setTaskHistory(prev => prev.map(t =>
                t.id === msg.task_id ? { ...t, status: 'error', finishedAt: Date.now(), result: msg.error } : t
              ));
            }
          } else if (msg.status === 'cancelled') {
            setToolLabel(null);
            setCometSteps(prev => [...prev.slice(-80), { icon: '\u{1F6AB}', text: 'Task cancelled', time: Date.now(), type: 'error' }]);
            setAgentState('idle');
            agentStateRef.current = 'idle';
            if (msg.task_id) {
              setTaskHistory(prev => prev.map(t =>
                t.id === msg.task_id ? { ...t, status: 'cancelled', finishedAt: Date.now() } : t
              ));
            }
          }
        } else if (msg.type === 'status') {
          agentStateRef.current = msg.state; // immediate update, no React delay
          setAgentState(msg.state);
          // Clear tool label when not acting anymore
          if (msg.state !== 'acting') setToolLabel(null);
          // Pre-emptive mic block: mute mic BEFORE audio arrives to prevent echo
          if (msg.state === 'speaking') audioPlayingRef.current = true;
          // Cancel all playing audio on interruption — prevents overlapping voices
          if (msg.state === 'listening') cancelAudio();
        } else if (msg.type === 'cron_update') {
          const cronTaskId = `cron_${msg.job_id}`;
          if (msg.status === 'started') {
            setCronJobs(prev => ({
              ...prev,
              [msg.job_id]: { task: msg.task, interval: msg.interval, lastTickTime: Date.now() },
            }));
          } else if (msg.status === 'running') {
            setCronJobs(prev => prev[msg.job_id] ? ({
              ...prev,
              [msg.job_id]: { ...prev[msg.job_id], running: true, currentAction: 'Starting...', step: 0, ...(msg.url ? { url: msg.url } : {}) },
            }) : prev);
            // Track cron run in task history
            setTaskHistory(prev => {
              const taskName = cronJobs[msg.job_id]?.task || msg.task || 'Recurring task';
              // Update existing or create new
              const existing = prev.find(t => t.id === cronTaskId && t.status === 'running');
              if (existing) return prev;
              return [...prev, { id: cronTaskId, task: `🔄 ${taskName}`, status: 'running' as const, startedAt: Date.now(), steps: [] }];
            });
          } else if (msg.status === 'step') {
            setCronJobs(prev => prev[msg.job_id] ? ({
              ...prev,
              [msg.job_id]: { ...prev[msg.job_id], running: true, currentAction: msg.action, step: msg.step, maxSteps: msg.max_steps, ...(msg.url ? { url: msg.url } : {}) },
            }) : prev);
            // Add step to task history
            setTaskHistory(prev => prev.map(t =>
              t.id === cronTaskId && t.status === 'running'
                ? { ...t, steps: [...t.steps, { tool: 'cron', label: msg.action || `Step ${msg.step}`, timestamp: Date.now() }] }
                : t
            ));
          } else if (msg.status === 'tick_done') {
            setCronJobs(prev => prev[msg.job_id] ? ({
              ...prev,
              [msg.job_id]: { ...prev[msg.job_id], lastResult: msg.result, lastTickTime: Date.now(), running: false, currentAction: undefined, step: undefined, ...(msg.url ? { url: msg.url } : {}) },
            }) : prev);
            // Mark cron run as done in task history
            setTaskHistory(prev => prev.map(t =>
              t.id === cronTaskId && t.status === 'running'
                ? { ...t, status: 'done' as const, finishedAt: Date.now(), result: msg.result }
                : t
            ));
          } else if (msg.status === 'modified') {
            setCronJobs(prev => prev[msg.job_id] ? ({
              ...prev,
              [msg.job_id]: { ...prev[msg.job_id], ...(msg.interval ? { interval: msg.interval } : {}), ...(msg.task ? { task: msg.task } : {}) },
            }) : prev);
          } else if (msg.status === 'stopped') {
            setCronJobs(prev => {
              const next = { ...prev };
              delete next[msg.job_id];
              return next;
            });
            // Mark as cancelled in task history
            setTaskHistory(prev => prev.map(t =>
              t.id === cronTaskId && t.status === 'running'
                ? { ...t, status: 'cancelled' as const, finishedAt: Date.now() }
                : t
            ));
          }
        } else if (msg.type === 'swarm_status') {
          // Swarm Decomposer status updates → comet overlay
          if (msg.subtasks) {
            setSwarmTasks(msg.subtasks);
          }
          if (msg.status === 'done') {
            // Mark all swarm tasks as done after delay
            setTimeout(() => setSwarmTasks([]), 5000);
          }
        } else if (msg.type === 'request_screenshot') {
          // Backend requests a per-task screenshot capture
          if (msg.task_id) {
            window.pulse.captureTaskScreenshot(msg.task_id).catch(() => {});
          }
        } else if (msg.type === 'open_gallery_tab') {
          // Open/reuse the Lobster Gallery tab
          window.pulse.openGalleryTab().catch(() => {});
        } else if (msg.type === 'live_ready') {
          console.log('[ws] Gemini Live is active and listening');
        } else if (msg.type === 'wake') {
          setAwake(msg.awake);
        } else if (msg.type === 'error') {
          addLog('error', msg.message);
        }
      } catch { /* ignore */ }
    };
    ws.onclose = () => {
      setWsConnected(false);
      // Reset audio queue on disconnect — prevents stale audio from piling up
      nextPlayTimeRef.current = 0;
      setTimeout(connectWS, 3000);
    };
    ws.onerror = () => {};
    wsRef.current = ws;
  }, [addLog, playAudioChunk, cancelAudio]);

  const sendAudio = useCallback((pcmData: ArrayBuffer) => {
    // BARGE-IN: if user is speaking while agent is talking, cancel local playback
    // But ALWAYS forward mic audio to backend — Gemini's VAD handles the rest
    if (audioPlayingRef.current) {
      const int16 = new Int16Array(pcmData);
      let sum = 0;
      for (let i = 0; i < int16.length; i++) sum += (int16[i] / 32768) ** 2;
      const rms = Math.sqrt(sum / int16.length);
      if (rms > 0.015) { // User is speaking → stop local playback (barge-in)
        console.log('[barge-in] User speaking over agent, cancelling audio');
        cancelAudio();
      }
      // Always send audio to backend — never gate the mic
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const header = new Uint8Array([0x01]);
      const combined = new Uint8Array(header.length + pcmData.byteLength);
      combined.set(header);
      combined.set(new Uint8Array(pcmData), header.length);
      wsRef.current.send(combined.buffer);
    }
  }, []);

  // ── Mic management (lifted from VoiceOrb) ──
  const stopMic = useCallback(() => {
    micProcessorRef.current?.disconnect();
    micProcessorRef.current = null;
    if (micAudioCtxRef.current && micAudioCtxRef.current.state !== 'closed') {
      micAudioCtxRef.current.close().catch(() => {});
    }
    micAudioCtxRef.current = null;
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    micStreamRef.current = null;
    micAnalyserRef.current = null;
    cancelAnimationFrame(micAnimFrameRef.current);
    setMicActive(false);
    setAudioLevel(0);
  }, []);

  const startMic = useCallback(async () => {
    if (micActive) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      micStreamRef.current = stream;
      const ctx = new AudioContext({ sampleRate: 16000 });
      micAudioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);
      micAnalyserRef.current = analyser;
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      micProcessorRef.current = processor;
      processor.onaudioprocess = (e) => {
        if (micMutedRef.current) return;
        const float32 = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          int16[i] = Math.max(-32768, Math.min(32767, Math.floor(float32[i] * 32768)));
        }
        sendAudio(int16.buffer);
      };
      source.connect(processor);
      processor.connect(ctx.destination);
      setMicActive(true);
      const updateLevel = () => {
        if (micAnalyserRef.current) {
          const data = new Uint8Array(micAnalyserRef.current.frequencyBinCount);
          micAnalyserRef.current.getByteFrequencyData(data);
          let sum = 0;
          const count = Math.min(data.length, 32);
          for (let i = 0; i < count; i++) sum += data[i];
          setAudioLevel(sum / count / 255);
        }
        micAnimFrameRef.current = requestAnimationFrame(updateLevel);
      };
      updateLevel();
    } catch (err) {
      console.error('Mic access failed:', err);
    }
  }, [micActive, sendAudio]);

  const toggleMic = useCallback(() => {
    const newMuted = !micMutedRef.current;
    setMicMuted(newMuted);
    micMutedRef.current = newMuted;
    if (newMuted) {
      stopMic();
    } else {
      startMic();
    }
  }, [stopMic, startMic]);

  // Auto-start mic when WebSocket connects (demo: voice works immediately)
  useEffect(() => {
    if (wsConnected && !micMutedRef.current && !micActive) {
      startMic();
    }
  }, [wsConnected, startMic, micActive]);

  // Cleanup mic on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(micAnimFrameRef.current);
      stopMic();
    };
  }, [stopMic]);

  const sendScreenshot = useCallback((base64: string, elementMap?: any[], taskId?: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      // Send annotated screenshot as binary (header 0x02)
      const bytes = atob(base64);
      const buf = new ArrayBuffer(bytes.length + 1);
      const view = new Uint8Array(buf);
      view[0] = 0x02;
      for (let i = 0; i < bytes.length; i++) view[i + 1] = bytes.charCodeAt(i);
      wsRef.current.send(buf);

      // Send element map as JSON (for vision brain precision clicking)
      if (elementMap && elementMap.length > 0) {
        wsRef.current.send(JSON.stringify({
          type: 'element_map', elements: elementMap,
          ...(taskId ? { task_id: taskId } : {}),
        }));
      }

      // Per-task screenshot: send as separate JSON so backend routes to correct executor
      if (taskId) {
        wsRef.current.send(JSON.stringify({
          type: 'task_screenshot', task_id: taskId, base64,
        }));

        // Update live agent screenshot (single state, not log entries)
        screenshotCountRef.current++;
        if (screenshotCountRef.current % 3 === 0) {
          setAgentScreenshot(base64);
        }
      }
    }
  }, []);

  const sendTextCommand = useCallback((text: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'text_command', text }));
      addLog('user', text);
    }
  }, [addLog]);

  useEffect(() => {
    window.pulse.onTabCreated(d => {
      const isAgent = (d as any).isAgent || false;
      setTabs(prev => [...prev, { ...d, active: !isAgent, isAgent }]);
      // Don't auto-switch to agent tabs — user stays on their view
      if (!isAgent) setActiveTabId(d.id);
    });
    window.pulse.onTabUpdated(d => setTabs(prev => prev.map(t => {
      if (t.id !== d.id) return t;
      // Merge update, preserve isAgent/isPrivate if set in either direction
      return {
        ...t, ...d,
        isAgent: (d as any).isAgent || t.isAgent,
        isPrivate: (d as any).isPrivate !== undefined ? (d as any).isPrivate : t.isPrivate,
      };
    })));
    window.pulse.onTabSwitched(d => {
      setActiveTabId(d.id);
      setTabs(prev => prev.map(t => ({ ...t, active: t.id === d.id })));
    });
    window.pulse.onTabClosed(d => setTabs(prev => prev.filter(t => t.id !== d.id)));
    window.pulse.onScreenshotCaptured(sendScreenshot);
  }, [sendScreenshot]);

  useEffect(() => {
    connectWS();
    return () => { wsRef.current?.close(); };
  }, [connectWS]);

  const handleUrlSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const raw = urlInput.trim();
    if (!raw) return;
    const isUrl = raw.includes('.') && !raw.includes(' ');
    const url = isUrl
      ? (raw.startsWith('http') ? raw : `https://${raw}`)
      : `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
    window.pulse.navigate(url);
    setUrlInput(url);
    setUrlFocused(false);
  }, [urlInput]);

  // Messages now handled entirely by MessageOverlay

  // JS-based window drag (CSS -webkit-app-region doesn't work with WebContentsView)
  // Uses dead zone (5px) to prevent accidental unmaximize on regular clicks
  const isDraggingRef = useRef(false);
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const dragActiveRef = useRef(false);
  const handleDragMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    let el: HTMLElement | null = target;
    for (let i = 0; i < 4 && el; i++) {
      const tag = el.tagName.toLowerCase();
      if (['button', 'input', 'select', 'textarea', 'a'].includes(tag)) return;
      if (el.getAttribute('role') === 'button' || el.hasAttribute('data-no-drag')) return;
      el = el.parentElement as HTMLElement;
    }
    isDraggingRef.current = true;
    dragActiveRef.current = false;
    dragStartPosRef.current = { x: e.screenX, y: e.screenY };
    const onMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      if (!dragActiveRef.current) {
        const dx = Math.abs(ev.screenX - (dragStartPosRef.current?.x ?? 0));
        const dy = Math.abs(ev.screenY - (dragStartPosRef.current?.y ?? 0));
        if (dx < 5 && dy < 5) return; // Dead zone — ignore tiny movements
        dragActiveRef.current = true;
        window.pulse.windowDragStart();
      }
      window.pulse.windowDragMove();
    };
    const onUp = () => {
      isDraggingRef.current = false;
      if (dragActiveRef.current) window.pulse.windowDragEnd();
      dragActiveRef.current = false;
      dragStartPosRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);
  const handleDragDblClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    let el: HTMLElement | null = target;
    for (let i = 0; i < 4 && el; i++) {
      const tag = el.tagName.toLowerCase();
      if (['button', 'input', 'select', 'textarea', 'a'].includes(tag)) return;
      if (el.getAttribute('role') === 'button' || el.hasAttribute('data-no-drag')) return;
      el = el.parentElement as HTMLElement;
    }
    window.pulse.windowMaximize();
  }, []);

  // ── UNIFIED LAYOUT — same structure for idle + browsing ──────────
  return (
    <div style={{
      width: '100vw', height: '100vh',
      background: '#050505',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* ── GLASS TOP BAR — Always visible, always the same ── */}
      <div
        onMouseDown={handleDragMouseDown}
        onDoubleClick={handleDragDblClick}
        style={{
          height: CHROME_H,
          minHeight: CHROME_H,
          position: 'relative',
          flexShrink: 0,
          zIndex: 10,
          cursor: 'default',
        }}
      >
        {/* Visual layer — backdrop-filter separated from drag (Windows Chromium bug) */}
        <div style={{
          position: 'absolute', inset: 0,
          background: hasTabs
            ? 'linear-gradient(180deg, rgba(18, 18, 22, 0.92) 0%, rgba(10, 10, 14, 0.88) 100%)'
            : 'linear-gradient(180deg, rgba(18, 18, 22, 0.55) 0%, rgba(10, 10, 14, 0.35) 100%)',
          backdropFilter: 'blur(40px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(40px) saturate(1.4)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 4px 24px rgba(0,0,0,0.3)',
          transition: 'background 0.4s ease',
          pointerEvents: 'none',
        }} />
        {/* Content layer — above visual and drag layers */}
        <div style={{
          position: 'relative',
          zIndex: 2,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
        }}>
        {/* Drag strip — 6px tall, full width, no interactive children */}
        <div style={{ height: 6, flexShrink: 0, cursor: 'grab' }} />
        {/* Row 1: Logo | Tabs | Agent Status | Voice | Win controls — 34px */}
        <div style={{
          height: 34,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 6px 0 12px',
        }}>
          {/* Logo */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <LobsterLogo size={20} animate={false} />
          </div>

          <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />

          {/* Tabs — individual tab buttons block drag, but gaps are draggable */}
          <div style={{
            flex: 1, minWidth: 0,
          }}>
            <TabBar
              tabs={tabs}
              activeTabId={activeTabId}
              cronJobs={cronJobs}
              onSwitchTab={id => window.pulse.switchTab(id)}
              onCloseTab={id => window.pulse.closeTab(id)}
              onNewTab={() => window.pulse.createTab('')}
              onCancelCron={(jobId) => {
                if (wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send(JSON.stringify({ type: 'text_command', text: `Cancel recurring task ${jobId}` }));
                }
                setCronJobs(prev => { const next = { ...prev }; delete next[jobId]; return next; });
              }}
              onDuplicateTab={(id) => {
                const tab = tabs.find(t => t.id === id);
                if (tab?.url) window.pulse.createTab(tab.url);
              }}
              onCloseOtherTabs={(id) => {
                tabs.forEach(t => { if (t.id !== id && !t.isAgent) window.pulse.closeTab(t.id); });
              }}
              onCloseTabsToRight={(id) => {
                const idx = tabs.findIndex(t => t.id === id);
                tabs.forEach((t, i) => { if (i > idx && !t.isAgent) window.pulse.closeTab(t.id); });
              }}
            />
          </div>

          {/* Agent status indicator + log toggle */}
          <div style={{
            display: 'flex', alignItems: 'center', flexShrink: 0,
          }}>
            <motion.button
              onClick={() => setShowAgentLog(v => !v)}
              whileTap={{ scale: 0.95 }}
              style={{
                display: 'flex', alignItems: 'center', gap: 0,
                padding: '0 10px 0 8px',
                height: 26, borderRadius: 13,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer', flexShrink: 0,
                overflow: 'hidden',
                position: 'relative',
              }}
              title={showAgentLog ? 'Hide agent log' : 'Show agent log'}
            >
              {/* Subtle glass bg — fades in when active */}
              <motion.div
                animate={{
                  opacity: agentState !== 'idle' ? 1 : 0,
                  background: `linear-gradient(135deg, ${(stateColors[agentState] || '#a78bfa')}08 0%, ${(stateColors[agentState] || '#a78bfa')}04 100%)`,
                }}
                transition={{ duration: 0.5, ease: 'easeOut' }}
                style={{
                  position: 'absolute', inset: 0, borderRadius: 13,
                  backdropFilter: 'blur(16px)',
                  WebkitBackdropFilter: 'blur(16px)',
                  pointerEvents: 'none',
                }}
              />
              {/* Animated glow ring when active */}
              {agentState !== 'idle' && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{
                    opacity: [0.08, 0.2, 0.08],
                    scale: [0.98, 1.02, 0.98],
                  }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut' }}
                  style={{
                    position: 'absolute', inset: -1, borderRadius: 14,
                    background: `radial-gradient(ellipse at 30% 50%, ${stateColors[agentState] || '#a78bfa'}25 0%, transparent 70%)`,
                    pointerEvents: 'none',
                  }}
                />
              )}
              {/* Content: icon + label with AnimatePresence crossfade */}
              <AnimatePresence mode="wait">
                <motion.div
                  key={agentState === 'acting' ? `act-${toolType}` : agentState}
                  initial={{ opacity: 0, filter: 'blur(6px)', x: -4 }}
                  animate={{ opacity: 1, filter: 'blur(0px)', x: 0 }}
                  exit={{ opacity: 0, filter: 'blur(6px)', x: 4 }}
                  transition={{ duration: 0.2, ease: [0.25, 0.46, 0.45, 0.94] }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    position: 'relative', zIndex: 1,
                    color: agentState !== 'idle'
                      ? (stateColors[agentState] || 'rgba(255,255,255,0.5)')
                      : wsConnected ? 'rgba(255,255,255,0.3)' : '#ef4444',
                  }}
                >
                  {/* Icon: tool-specific SVG when acting, pulsing dot otherwise */}
                  {agentState === 'acting' && toolIcons[toolType] ? (
                    <motion.span
                      animate={{ opacity: [0.7, 1, 0.7] }}
                      transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
                      style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}
                    >
                      {toolIcons[toolType]}
                    </motion.span>
                  ) : (
                    <motion.div
                      animate={agentState !== 'idle' ? {
                        scale: [1, 1.5, 1],
                        opacity: [0.6, 1, 0.6],
                      } : {}}
                      transition={agentState !== 'idle'
                        ? { duration: 1.8, repeat: Infinity, ease: 'easeInOut' }
                        : { duration: 0.3 }
                      }
                      style={{
                        width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                        background: agentState !== 'idle'
                          ? (stateColors[agentState] || '#fff')
                          : wsConnected ? '#4ade80' : '#ef4444',
                        boxShadow: agentState !== 'idle'
                          ? `0 0 6px ${stateColors[agentState] || '#a78bfa'}60`
                          : 'none',
                      }}
                    />
                  )}
                  {/* Label */}
                  <span style={{
                    fontSize: 10, fontWeight: 500,
                    fontFamily: "'Inter', sans-serif",
                    letterSpacing: '0.05em',
                    textTransform: 'uppercase' as const,
                    maxWidth: 150,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    opacity: 0.85,
                  }}>
                    {agentState === 'acting' && toolLabel ? toolLabel : (stateLabels[agentState] || 'Ready')}
                  </span>
                </motion.div>
              </AnimatePresence>
            </motion.button>
          </div>

          <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />

          {/* Window controls — far right, Chrome-style */}
          <div style={{ flexShrink: 0 }}>
            <WindowControls />
          </div>
        </div>

        {/* Row 2: Back | Fwd | URL | Refresh — 44px */}
        <div style={{
          height: 44,
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '0 10px',
        }}>
          {/* Back */}
          <button onClick={() => window.pulse.goBack()} title="Back" style={navBtn}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>

          {/* Forward */}
          <button onClick={() => window.pulse.goForward()} title="Forward" style={navBtn}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>

          {/* URL bar */}
          <form onSubmit={handleUrlSubmit} style={{ flex: 1, display: 'flex' }}>
            <input
              ref={urlInputRef}
              type="text"
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              onFocus={e => { setUrlFocused(true); e.target.select(); }}
              onBlur={() => {
                setUrlFocused(false);
                const t = tabs.find(t => t.id === activeTabId);
                setUrlInput(t?.url || '');
              }}
              placeholder="Search or type a URL..."
              style={{
                flex: 1,
                height: 30,
                background: urlFocused
                  ? 'rgba(255,255,255,0.1)'
                  : 'rgba(255,255,255,0.04)',
                border: urlFocused
                  ? '1px solid rgba(255,43,68,0.45)'
                  : '1px solid rgba(255,255,255,0.07)',
                borderRadius: 10,
                padding: '0 14px',
                color: urlFocused ? '#fff' : 'rgba(255,255,255,0.6)',
                fontSize: 12.5,
                fontFamily: "'Inter', sans-serif",
                fontWeight: 400,
                outline: 'none',
                letterSpacing: '0.01em',
                transition: 'all 0.22s ease',
                boxShadow: urlFocused
                  ? '0 0 0 2px rgba(255,43,68,0.15), inset 0 1px 0 rgba(255,255,255,0.05)'
                  : 'inset 0 1px 0 rgba(255,255,255,0.03)',
              }}
            />
          </form>

          {/* Refresh */}
          <button
            onClick={() => {
              const t = tabs.find(t => t.id === activeTabId);
              if (t?.url) window.pulse.navigate(t.url);
            }}
            title="Refresh"
            style={navBtn}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>

          {/* Zoom controls — only show when != 100% */}
          {zoomLevel !== 100 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <button onClick={async () => setZoomLevel(await window.pulse.zoomOut())} title="Zoom out" style={navBtn}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
              <button
                onClick={async () => setZoomLevel(await window.pulse.zoomReset())}
                title="Reset zoom"
                style={{ ...navBtn, width: 'auto', padding: '0 4px', fontSize: 10, fontFamily: "'Inter', sans-serif", color: 'rgba(255,255,255,0.5)' }}
              >
                {zoomLevel}%
              </button>
              <button onClick={async () => setZoomLevel(await window.pulse.zoomIn())} title="Zoom in" style={navBtn}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
            </div>
          )}

          {/* Zoom button (when at 100%, just shows magnifying glass to zoom in) */}
          {zoomLevel === 100 && (
            <button onClick={async () => setZoomLevel(await window.pulse.zoomIn())} title="Zoom in" style={navBtn}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                <line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
              </svg>
            </button>
          )}

          {/* Downloads button */}
          <button
            onClick={() => window.pulse.openDownloads()}
            title="Downloads"
            style={{
              ...navBtn,
              position: 'relative',
              color: downloadProgress >= 0 ? 'rgba(74,222,128,0.9)' : 'rgba(255,255,255,0.45)',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            {downloadProgress >= 0 && (
              <div style={{
                position: 'absolute', bottom: 2, left: '50%', transform: 'translateX(-50%)',
                width: 16, height: 2, borderRadius: 1,
                background: 'rgba(255,255,255,0.1)',
              }}>
                <div style={{
                  width: `${downloadProgress}%`, height: '100%',
                  background: '#4ade80', borderRadius: 1,
                  transition: 'width 0.3s ease',
                }} />
              </div>
            )}
          </button>

          {/* Divider — separates browser controls from agent controls */}
          <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />

          {/* Chat button — icon */}
          <button
            onClick={() => {
              if (showTaskPanel && taskPanelTab === 'chat') {
                setShowTaskPanel(false);
              } else {
                setTaskPanelTab('chat');
                setShowTaskPanel(true);
              }
            }}
            title="Chat"
            style={{
              ...navBtn,
              color: showTaskPanel && taskPanelTab === 'chat' ? 'rgba(255,43,68,0.9)' : 'rgba(255,255,255,0.45)',
              background: showTaskPanel && taskPanelTab === 'chat' ? 'rgba(255,43,68,0.1)' : 'rgba(255,255,255,0.04)',
              border: showTaskPanel && taskPanelTab === 'chat' ? '1px solid rgba(255,43,68,0.25)' : '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>

          {/* Compact mic (VoiceOrb) */}
          <VoiceOrb
            mode="compact"
            state={agentState}
            wsConnected={wsConnected}
            awake={awake}
            muted={micMuted}
            micActive={micActive}
            audioLevel={audioLevel}
            onToggleMute={toggleMic}
            sendTextCommand={sendTextCommand}
            onChatToggle={() => {
              setTaskPanelTab('chat');
              setShowTaskPanel(v => !v);
            }}
          />

          {/* Speaker mute button */}
          <button
            onClick={() => {
              const next = !speakerMuted;
              setSpeakerMuted(next);
              if (next) cancelAudio();
            }}
            title={speakerMuted ? 'Unmute Speaker' : 'Mute Speaker'}
            style={{
              ...navBtn,
              position: 'relative',
              color: !speakerMuted ? 'rgba(255,43,68,0.9)' : 'rgba(255,255,255,0.45)',
              background: !speakerMuted ? 'rgba(255,43,68,0.1)' : 'rgba(255,255,255,0.04)',
              border: !speakerMuted ? '1px solid rgba(255,43,68,0.25)' : '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              {speakerMuted ? (
                <>
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </>
              ) : (
                <>
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                </>
              )}
            </svg>
          </button>

          {/* Tasks panel toggle — icon */}
          <button
            onClick={() => {
              if (showTaskPanel && taskPanelTab === 'tasks') {
                setShowTaskPanel(false);
              } else {
                setTaskPanelTab('tasks');
                setShowTaskPanel(true);
              }
            }}
            title="Tasks"
            style={{
              ...navBtn,
              position: 'relative',
              color: showTaskPanel && taskPanelTab === 'tasks' ? 'rgba(255,43,68,0.9)' : 'rgba(255,255,255,0.45)',
              background: showTaskPanel && taskPanelTab === 'tasks' ? 'rgba(255,43,68,0.1)' : 'rgba(255,255,255,0.04)',
              border: showTaskPanel && taskPanelTab === 'tasks' ? '1px solid rgba(255,43,68,0.25)' : '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
            {taskHistory.filter(t => t.status === 'running').length > 0 && (
              <span style={{
                position: 'absolute', top: -2, right: -2,
                width: 14, height: 14, borderRadius: '50%',
                background: 'rgba(255,43,68,0.9)', fontSize: 8, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#fff', border: '1.5px solid rgba(14,14,18,0.9)',
              }}>
                {taskHistory.filter(t => t.status === 'running').length}
              </span>
            )}
          </button>
        </div>
        </div>{/* end content layer */}
      </div>{/* end glass top bar */}

      {/* ── Action Guardrail Confirmation Modal ── */}
      <ConfirmModal
        visible={!!confirmAction}
        action={confirmAction?.action || ''}
        url={confirmAction?.url || ''}
        onAllow={() => {
          if (confirmAction) window.pulse.respondConfirmAction(confirmAction.requestId, true);
          setConfirmAction(null);
        }}
        onDeny={() => {
          if (confirmAction) window.pulse.respondConfirmAction(confirmAction.requestId, false);
          setConfirmAction(null);
        }}
      />

      {/* ── Find in Page bar ── */}
      <FindBar visible={showFindBar} onClose={() => setShowFindBar(false)} />

      {/* ── Command Palette (Ctrl+K) ── */}
      <CommandPalette
        visible={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        tabs={tabs}
        onSwitchTab={id => window.pulse.switchTab(id)}
        onNewTab={(url?: string) => window.pulse.createTab(url || '')}
        sendTextCommand={sendTextCommand}
      />

      {/* ── Ghost Tab Indicator — agent working in background ── */}
      <AnimatePresence>
        {ghostTab && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.9 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            style={{
              position: 'fixed',
              bottom: 16,
              left: 16,
              zIndex: 90,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 12px 6px 10px',
              background: 'rgba(18,18,22,0.88)',
              backdropFilter: 'blur(20px) saturate(1.3)',
              WebkitBackdropFilter: 'blur(20px) saturate(1.3)',
              border: '1px solid rgba(255,43,68,0.25)',
              borderRadius: 12,
              boxShadow: '0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06)',
              cursor: 'pointer',
            }}
          >
            {/* Pulsing dot */}
            <motion.div
              animate={{ scale: [1, 1.4, 1], opacity: [0.8, 1, 0.8] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
              style={{
                width: 8, height: 8, borderRadius: '50%',
                background: '#ff2b44',
                boxShadow: '0 0 8px rgba(255,43,68,0.5)',
                flexShrink: 0,
              }}
            />
            <span style={{
              fontSize: 11.5, color: 'rgba(255,255,255,0.7)',
              fontFamily: "'Inter', sans-serif",
              fontWeight: 500,
              maxWidth: 200,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              Agent working...
            </span>
            <span style={{
              fontSize: 10, color: 'rgba(255,255,255,0.35)',
              fontFamily: "'Inter', sans-serif",
              maxWidth: 140,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              {ghostTab.title}
            </span>
            <button
              onClick={async (e) => {
                e.stopPropagation();
                if (isPeeking) {
                  await window.pulse.unpeekGhostTab();
                  setIsPeeking(false);
                } else {
                  await window.pulse.peekGhostTab();
                  setIsPeeking(true);
                }
              }}
              style={{
                fontSize: 10, fontWeight: 600,
                color: isPeeking ? '#ff2b44' : 'rgba(255,255,255,0.5)',
                background: isPeeking ? 'rgba(255,43,68,0.15)' : 'rgba(255,255,255,0.06)',
                border: isPeeking ? '1px solid rgba(255,43,68,0.3)' : '1px solid rgba(255,255,255,0.08)',
                borderRadius: 6,
                padding: '2px 8px',
                cursor: 'pointer',
                fontFamily: "'Inter', sans-serif",
                transition: 'all 0.15s ease',
              }}
            >
              {isPeeking ? 'Hide' : 'Peek'}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── MESSAGE OVERLAY — glassmorphic toasts from bottom-center ── */}
      <MessageOverlay log={agentLog} agentState={agentState} />

      {/* ── FOCUS MODE — floating orb + exit button ── */}
      <AnimatePresence>
        {focusMode && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            style={{
              position: 'fixed',
              bottom: 16, right: 16,
              zIndex: 200,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <VoiceOrb
              mode="compact"
              state={agentState}
              wsConnected={wsConnected}
              awake={awake}
              muted={micMuted}
              micActive={micActive}
              audioLevel={audioLevel}
              onToggleMute={toggleMic}
              sendTextCommand={sendTextCommand}
            />
            <button
              onClick={() => window.pulse.toggleFocusMode()}
              style={{
                padding: '4px 10px',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'rgba(18,18,22,0.8)',
                backdropFilter: 'blur(12px)',
                color: 'rgba(255,255,255,0.5)',
                fontSize: 10,
                fontFamily: "'Inter', sans-serif",
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              Exit Focus
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── IDLE CONTENT — shown when no tabs or new tab is active ── */}
      <AnimatePresence>
        {showStartPage && (
          <motion.div
            key="idle-content"
            initial={{ opacity: 0 }}
            animate={{ opacity: splashPhase === 'done' ? 1 : 0 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            style={{
              flex: 1,
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            {/* WebGL Aurora background */}
            <div style={{ position: 'absolute', inset: 0, zIndex: 0 }}>
              <Aurora
                colorStops={['#cc0000', '#ff2b44', '#aa0060']}
                amplitude={1.1}
                blend={0.6}
                speed={0.8}
              />
            </div>

            {/* Centered content: logo + tagline + speech + voice pill */}
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              gap: 20, zIndex: 5,
              pointerEvents: 'none',
            }}>
              <motion.div
                initial={{ opacity: 0, y: 32 }}
                animate={splashPhase === 'done' ? { opacity: 1, y: 0 } : { opacity: 0, y: 32 }}
                transition={{ duration: 1, ease: [0.16, 1, 0.3, 1], delay: 0.15 }}
                style={{ display: 'flex', alignItems: 'center', gap: 22, pointerEvents: 'none' }}
              >
                <LobsterLogo size={64} />
                <h1 style={{
                  fontSize: 64, fontWeight: 400, color: '#fff', margin: 0,
                  fontFamily: "'Italiana', serif",
                  letterSpacing: '-0.035em',
                  textShadow: '0 2px 32px rgba(0,0,0,0.8)',
                }}>Lobster</h1>
              </motion.div>

              <motion.p
                initial={{ opacity: 0 }}
                animate={splashPhase === 'done' ? { opacity: 0.55 } : { opacity: 0 }}
                transition={{ duration: 1.4, delay: 0.35 }}
                style={{
                  color: '#fff', fontSize: 24, margin: 0,
                  fontFamily: "'Instrument Serif', serif",
                  fontWeight: 400,
                  letterSpacing: '0.01em', pointerEvents: 'none',
                }}
              >
                The World's First Native Live-Agent Browser
              </motion.p>

              {/* Voice pill — centered with everything (messages handled by MessageOverlay) */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={splashPhase === 'done' ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
                transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: 0.45 }}
                style={{ pointerEvents: 'auto', marginTop: 8 }}
              >
                <VoiceOrb
                  mode="idle"
                  state={agentState}
                  wsConnected={wsConnected}
                  awake={awake}
                  muted={micMuted}
                  micActive={micActive}
                  audioLevel={audioLevel}
                  onToggleMute={toggleMic}
                  sendTextCommand={sendTextCommand}
                />
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* CometOverlay removed — activity feed integrated into TaskPanel sidebar */}

      {/* ── TASK HISTORY PANEL — slide-out drawer ── */}
      <TaskPanel
        show={showTaskPanel}
        tasks={taskHistory}
        cronJobs={cronJobs}
        activitySteps={cometSteps}
        swarmTasks={swarmTasks}
        agentState={agentState}
        chatMessages={agentLog}
        agentScreenshot={agentScreenshot}
        sendTextCommand={sendTextCommand}
        initialTab={taskPanelTab}
        onClose={() => setShowTaskPanel(false)}
        onRetryTask={(text) => sendTextCommand(text)}
        onDeleteTask={(taskId) => setTaskHistory(prev => prev.filter(t => t.id !== taskId))}
        onModifyCron={(jobId, interval) => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'cron_modify', job_id: jobId, interval }));
          }
        }}
        onCancelCron={(jobId) => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'text_command', text: 'cancel cron' }));
          }
          setCronJobs(prev => { const n = { ...prev }; delete n[jobId]; return n; });
        }}
        onUpdateCronTask={(jobId, newTask) => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'cron_update_task', job_id: jobId, task: newTask }));
          }
          setCronJobs(prev => prev[jobId] ? { ...prev, [jobId]: { ...prev[jobId], task: newTask } } : prev);
        }}
      />

      {/* ── SPLASH — video fades to black, then instant cut to homepage ── */}
      <AnimatePresence>
        {splashPhase !== 'done' && (
          <motion.div
            key="splash-overlay"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6, ease: [0.25, 0.1, 0.25, 1] }}
            style={{
              position: 'fixed', inset: 0, zIndex: 9999,
              background: '#000',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <div style={{
              position: 'absolute', inset: 0, zIndex: 2,
              background: 'radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.6) 70%, rgba(0,0,0,0.95) 100%)',
              pointerEvents: 'none',
            }} />
            {splashVideoUrl && (
              <motion.video
                initial={{ opacity: 0 }}
                animate={{ opacity: splashPhase === 'video' ? 1 : 0 }}
                transition={splashPhase === 'video'
                  ? { duration: 0.5, ease: 'easeOut' }
                  : { duration: 2.0, ease: [0.25, 0.1, 0.25, 1] }
                }
                src={splashVideoUrl}
                autoPlay
                playsInline
                onLoadedData={(e) => {
                  // Unmute after load — autoplay policy requires starting muted
                  const v = e.currentTarget;
                  v.muted = false;
                  v.volume = 0.7;
                }}
                muted
                onTimeUpdate={(e) => {
                  const v = e.currentTarget;
                  if (v.duration && v.currentTime > 0 && v.duration - v.currentTime < 2.5 && splashPhase === 'video') {
                    setSplashPhase('fadeout');
                  }
                }}
                onEnded={() => { if (splashPhase === 'video') setSplashPhase('fadeout'); }}
                onError={() => setSplashPhase('done')}
                style={{
                  width: '100%', height: '100%',
                  objectFit: 'cover',
                  zIndex: 1,
                }}
              />
            )}
            {!splashVideoUrl && <FallbackSplashTimer onDone={() => setSplashPhase('done') } />}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Fallback: dismiss splash after timeout if video URL can't be resolved
function FallbackSplashTimer({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2000);
    return () => clearTimeout(t);
  }, [onDone]);
  return null;
}


const navBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 28, height: 28, borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)',
  background: 'rgba(255,255,255,0.04)',
  color: 'rgba(255,255,255,0.5)',
  cursor: 'pointer', flexShrink: 0,
  transition: 'all 0.18s ease',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
};
