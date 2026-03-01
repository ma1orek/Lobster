"""Lobster Browser Backend — Two-Brain Architecture.

Brain 1: CONDUCTOR (Gemini Live API) — voice interface, 0-latency conversation, delegates tasks
Brain 2: EXECUTOR (Gemini Standard API) — background browser automation with vision + tools

The Conductor NEVER sees screenshots. It only hears the user and speaks back.
The Executor works silently in the background, executing multi-step browser tasks.
When the Executor finishes, it injects [TASK_DONE] into the Conductor's context.
"""

import os
import re
import json
import asyncio
import time
import traceback
import base64
import struct
from urllib.parse import quote_plus
from dotenv import load_dotenv
import numpy as np

load_dotenv()

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from google import genai
from google.genai import types
from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.tools import ToolContext

# ── Shared per-session state ──
from skills._base import (
    _action_queues, _result_queues, _screenshots,
    _element_maps, _websockets, _live_queues, _last_transcript,
    _format_element_map_for_model,
)

app = FastAPI(title="Lobster Browser Backend", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Models ──
CONDUCTOR_MODEL = "gemini-2.5-flash-native-audio-preview-09-2025"  # Voice only
ROUTER_MODEL = "gemini-3-flash-preview"                             # JSON intent classification
EXECUTOR_CU_MODEL = "gemini-3-flash-preview"                        # Computer Use (visual actions)
EXECUTOR_TOOLS_MODEL = "gemini-3-flash-preview"                     # Code-first executor + cron (flash = higher rate limits)
IMAGE_GEN_MODEL = "gemini-3.1-flash-image-preview"                     # Image generation (Nano Banana 2 — fastest)

# ── Genai client for Executor (standard API) ──
os.environ.setdefault("GOOGLE_API_KEY", os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY") or "")
genai_client = genai.Client(api_key=os.environ.get("GOOGLE_API_KEY"))

# ── ai-coustics Speech Enhancement (preprocessing layer before Gemini) ──
_aic_processor = None
_aic_config = None

def _init_aicoustics():
    """Initialize ai-coustics speech enhancement. Falls back to raw audio on failure."""
    global _aic_processor, _aic_config
    try:
        import aic_sdk as aic
        license_key = os.getenv("AICOUSTICS_LICENSE_KEY")
        if not license_key:
            print("[ai-coustics] No AICOUSTICS_LICENSE_KEY env var — skipping speech enhancement")
            return
        # Download model (cached after first run)
        model_path = aic.Model.download("quail-vf-l-16khz", "./models")
        model = aic.Model.from_file(model_path)
        # Optimal config for mono 16kHz (matches our mic capture)
        _aic_config = aic.ProcessorConfig.optimal(model, num_channels=1, allow_variable_frames=True)
        _aic_processor = aic.Processor(model, license_key, _aic_config)
        print(f"[ai-coustics] Speech enhancement initialized (model=quail-vf-l-16khz, frames={_aic_config.num_frames})")
    except ImportError:
        print("[ai-coustics] aic_sdk not installed — pip install aic-sdk — skipping speech enhancement")
    except Exception as e:
        print(f"[ai-coustics] Init failed, falling back to raw audio: {e}")
        _aic_processor = None

_init_aicoustics()

def _enhance_audio_pcm16(pcm16_bytes: bytes) -> bytes:
    """Enhance PCM16 mono 16kHz audio through ai-coustics. Returns enhanced PCM16 or original on failure."""
    if _aic_processor is None:
        return pcm16_bytes
    try:
        # PCM16 little-endian → float32 numpy array (1 channel × N frames)
        samples = np.frombuffer(pcm16_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        audio_2d = samples.reshape(1, -1)  # shape: (1, num_frames) — mono
        # Process through ai-coustics
        enhanced = _aic_processor.process(audio_2d)
        # float32 → PCM16 bytes
        enhanced_int16 = (enhanced.flatten() * 32768.0).clip(-32768, 32767).astype(np.int16)
        return enhanced_int16.tobytes()
    except Exception:
        return pcm16_bytes  # Silent fallback to raw audio

# ── Per-session executor state ──
_executor_tasks: dict[str, dict[str, asyncio.Task]] = {}  # sid → {task_id → Task}
_handoff_pending: dict[str, bool] = {}  # Per-session flag: executor just sent a handoff
_audio_mute_until_map: dict[str, float] = {}  # Per-session: mute audio input until this timestamp
_executor_active: dict[str, set] = {}  # Per-session: set of active task_ids
_delegations_this_turn: dict[str, int] = {}  # Per-session: how many delegations in current turn
_task_result_queues: dict[str, asyncio.Queue] = {}  # task_id → result Queue
_task_screenshots: dict[str, bytes] = {}  # task_id → latest screenshot bytes
_task_element_maps: dict[str, list] = {}  # task_id → latest element map
MAX_CONCURRENT_TASKS = 3  # Allow up to 3 parallel executor tasks
_ALREADY_HANDLED = {"status": "error", "result": "Maximum 3 concurrent tasks. Wait for one to finish or give a new command."}
_awake_state: dict[str, bool] = {}  # sid → awake (True = user said "Hey Lobster")
_conversation_history: dict[str, list] = {}  # sid → [{"role": "user"|"agent", "text": "..."}] — last N turns for reconnect context
_CONVERSATION_HISTORY_MAX = 15  # Keep last 15 turns
# COST TRACKING
_api_calls_session: dict[str, int] = {}  # session_id → API calls this session
_api_calls_total: int = 0  # Total API calls since server start

def _append_conversation(sid: str, role: str, text: str):
    """Append a turn to the conversation history (capped at _CONVERSATION_HISTORY_MAX)."""
    if not text or len(text.strip()) < 2:
        return
    hist = _conversation_history.setdefault(sid, [])
    hist.append({"role": role, "text": text.strip()[:300]})
    if len(hist) > _CONVERSATION_HISTORY_MAX:
        _conversation_history[sid] = hist[-_CONVERSATION_HISTORY_MAX:]

# ── Cron jobs (recurring tasks) ──
import uuid as _uuid
_cron_jobs: dict[str, dict] = {}  # job_id → {session_id, task, interval, category, asyncio_task, paused, last_result}
_swarm_tracker: dict[str, dict] = {}  # swarm_id → {session_id, task, targets, task_ids, results}

# ── Hive Memory — shared persistent state across all agents/executors ──
_HIVE_MEMORY: dict[str, dict] = {}  # session_id → {key: {value, source, ts}}
_task_image_generated: dict[str, bool] = {}  # task_id → True if image already generated this task


# ── Tool activity labels (Polish) ──

def _tool_label(name: str, args: dict) -> str:
    """Human-readable English label for tool calls shown to user."""
    labels = {
        "navigate_to": lambda a: f"Opening {a.get('url', '')[:40]}…",
        "search_web": lambda a: f"Searching: {a.get('query', '')}",
        "go_back": lambda a: "Going back",
        "go_forward": lambda a: "Going forward",
        "click_element": lambda a: "Clicking…",
        "click_element_ref": lambda a: f"Clicking #{a.get('ref', '')}",
        "click_element_by_text": lambda a: f"Clicking: {a.get('text', '')[:30]}",
        "type_text": lambda a: f"Typing: {a.get('text', '')[:30]}",
        "press_key": lambda a: f"Pressing {a.get('key', '')}",
        "press_enter": lambda a: "Enter",
        "scroll_page": lambda a: f"Scrolling {a.get('direction', 'down')}",
        "scroll_to_text": lambda a: f"Finding: {a.get('text', '')[:30]}",
        "extract_page_text": lambda a: "Reading page…",
        "read_page_as_markdown": lambda a: "Reading page…",
        "mouse_drag": lambda a: "Drawing…",
        "draw_with_cursor": lambda a: f"Sketching: {a.get('description', '')[:30]}…",
        "open_new_tab": lambda a: "New tab…",
        "close_current_tab": lambda a: "Closing tab…",
        "dismiss_cookies": lambda a: "Dismissing cookies…",
        "evaluate_javascript": lambda a: "Running JS…",
        "select_dropdown": lambda a: "Selecting…",
        "hover_element": lambda a: "Hovering…",
        "double_click": lambda a: "Double-clicking…",
    }
    fn = labels.get(name)
    if fn:
        try:
            return fn(args)
        except Exception:
            return name
    return name


# ══════════════════════════════════════════════════════════════════════
# BRAIN 1: CONDUCTOR — Voice Interface (Gemini Live API)
# Only 3 router tools. NO screenshots. Just voice + delegation.
# ══════════════════════════════════════════════════════════════════════

CONDUCTOR_INSTRUCTION = """You are Lobster — a charismatic, witty AI voice assistant inside a next-generation web browser called Pulse. You speak ONLY ENGLISH. You are a LIVE conversational partner — think Jarvis from Iron Man, but friendlier and with personality.

LANGUAGE & TRANSCRIPTION:
- ALWAYS speak English. Even if the user speaks Polish or another language, YOU reply in English.
- You can understand any language the user speaks, but your responses are ALWAYS in English.
- The user often speaks POLISH mixed with English terms (e.g., "otwórz LinkedIn", "wyślij wiadomość", "przejdź na YouTube").
- When transcribing user speech, preserve proper nouns correctly: LinkedIn, YouTube, Reddit, Google, Twitter, Facebook, etc.
- Common Polish words you'll hear: "otwórz" (open), "wyszukaj" (search), "wyślij" (send), "wiadomość" (message), "na" (to/on), "do" (to), "strona" (page/website).

PERSONALITY:
- Confident, witty, warm, genuinely helpful — like chatting with a brilliant friend
- You're casual but sharp. Use natural speech patterns: "Alright!", "Got it!", "On it!", "Sure thing!", "Here's the deal..."
- You have opinions and personality — you're NOT a boring corporate assistant
- Vary your responses! Never repeat the same phrase twice in a row
- Be enthusiastic about interesting tasks, empathetic about frustrations
- You can joke, be sarcastic (lightly), show excitement

ON STARTUP:
- Greet warmly: "Hey! Lobster here, ready to roll!" or "What's up? What are we doing today?"

CONVERSATION — BE NATURAL:
- When the user greets you → greet back warmly, maybe ask what they need
- When they ask how you are → respond like a person: "Doing great! What can I help with?"
- When they ask a general question → answer it conversationally, like a knowledgeable friend
- When they chat casually → chat back! You're a companion, not just a task executor
- When they give a CLEAR TASK → confirm briefly + call execute_user_intent(intent)
- Keep responses SHORT: 1-3 sentences. Be conversational, not robotic.

TASK HANDLING:
- CLEAR TASK (open site, search, message someone, draw, monitor) → call execute_user_intent FIRST, then confirm vocally
- Confirm with personality: "Opening YouTube for you!", "Alright, searching for that now!", "On it — messaging them right away!"
- If unsure what they want → ask naturally: "Sorry, what was that?" or "Could you say that again?"

TASK RESULTS ("Task done: ..."):
- Deliver results naturally: "Done! YouTube is ready.", "Found 3 new posts on Reddit!", "Hmm, something went wrong there."
- If there's useful info in the result, share it briefly
- 1-2 sentences, then STOP.

RECURRING TASK UPDATES ("Recurring task update:" or "CRON UPDATE:"):
- You MUST speak these to the user — that's the whole point of monitoring
- Summarize: "Hey, new Reddit post just dropped: [title]!" or "Checked Twitter — 2 new mentions!"
- Be specific about what changed. Keep it brief.
- NEVER stay silent on a cron update.

SWARM RESULTS ("URGENT" or aggregated results):
- These are results from parallel agents. YOU MUST speak them immediately.
- Summarize clearly: "Alright, here's what I found across all three sites..."
- Be organized and helpful in delivery.

TYPED COMMANDS ("[USER TYPED]:"):
- Already auto-routed to executor. Just give a SHORT confirmation: "On it!" or "Got it, working on that!"

NOISE FILTERING — CRITICAL:
- You will hear background noise, music, echoes, half-words. This is NORMAL.
- ONLY call execute_user_intent for CLEAR, EXPLICIT COMMANDS with a specific action verb.
- Real commands: "open YouTube", "search for latest news", "send a message to John", "draw a cat", "go to LinkedIn"
- NOT commands: opinions, questions about you, chat, compliments, "hello", "ok", "yeah", "cool", fragments, garbled audio
- CONVERSATION examples (NEVER call execute_user_intent for these):
  "that's cool" → just reply naturally
  "how does this work?" → explain, don't execute
  "the agent is doing great" → say thanks, don't execute
  "interesting" → acknowledge, don't execute
  "I'm just testing" → respond, don't execute
  User talking about the app/features → DISCUSS, don't execute
- If the user is TALKING ABOUT the agent or browser → it's CONVERSATION, not a command
- If unclear → ask: "Sorry, what was that?" Do NOT call execute_user_intent.
- If completely garbled → STAY SILENT. Say nothing.
- NEVER call execute_user_intent with 1-2 word fragments or conversational phrases.
- When in doubt: RESPOND VERBALLY, do NOT call execute_user_intent.

MULTI-TASKING:
- You CAN chat naturally even while a background task is running!
- If a task is running and the user asks a general question ("what's the weather?", "tell me a joke"), ANSWER IT normally.
- Only refuse to start a NEW browser task if one is already running: "I'm still working on the previous thing, give me a sec."
- You are NEVER mute or frozen. Always respond to the user, even during background work.

RULES:
- TOOL CALL FIRST, then speak. Call execute_user_intent before your verbal response.
- NEVER call execute_user_intent twice for the same request.
- NEVER mention payments, subscriptions, money unless asked.
- Be concise! 1-3 sentences max. No monologues or lectures.
- ALWAYS respond when the user speaks to you. Never ignore them.
- If you hear the user clearly, ALWAYS acknowledge them — even if just "Yeah?" or "I'm here!"

IDENTITY — YOU ARE LOBSTER:
- You are a red lobster character — the browser's mascot
- If asked for a selfie/self-portrait → tell executor: "Generate a selfie of Lobster, the red lobster mascot"
- You're proud of being Lobster! Reference it naturally when relevant

Tools: activate_listening(), execute_user_intent(intent)"""


# ── Router Tools (called by Conductor, spawn Executor) ──

def _cancel_active_tasks(sid: str):
    """Cancel running executor tasks (NOT cron jobs) so a new command can start clean."""
    tasks = _executor_tasks.get(sid, {})
    active = _executor_active.get(sid, set())
    cancelled = []
    for tid, t in list(tasks.items()):
        if tid.startswith("cron_"):
            continue  # Never cancel cron jobs when user gives a new command
        if not t.done():
            t.cancel()
            cancelled.append(tid)
    for tid in cancelled:
        tasks.pop(tid, None)
        active.discard(tid)
    if cancelled:
        print(f"[executor] Auto-cancelled {len(cancelled)} tasks for new command: {cancelled}")


def _can_delegate(sid: str) -> bool:
    """Check if delegation is allowed. Allows parallel tasks up to MAX_CONCURRENT_TASKS."""
    if _delegations_this_turn.get(sid, 0) >= 1:
        return False
    # Count only non-cron active tasks
    active = _executor_active.get(sid, set())
    non_cron_active = {t for t in active if not t.startswith("cron_")}
    if len(non_cron_active) >= MAX_CONCURRENT_TASKS:
        return False  # At capacity — don't cancel, just reject
    return True


async def activate_listening(tool_context: ToolContext) -> dict:
    """Call when user says 'Hey Lobster'. Activates voice output."""
    return {
        "status": "activated",
        "message": "Listening activated. If the user included a command, call execute_user_intent NOW in this same turn."
    }


_last_intent: dict[str, tuple[str, float]] = {}  # sid → (intent, timestamp) for dedup

# Wake word patterns to strip from intents
_WAKE_PATTERNS = [
    "hey lobster", "hej lobster", "hey, lobster", "hej, lobster",
    "hello lobster", "hi lobster", "he lobster", "lobster",
    "hey lobstar", "hej lobstar", "halo lobster",
]

def _strip_wake_word(intent: str) -> str:
    """Remove wake word prefix from intent, return the actual command."""
    lower = intent.lower().strip()
    for pattern in _WAKE_PATTERNS:
        if lower.startswith(pattern):
            remainder = intent[len(pattern):].strip().lstrip(",").lstrip(".").strip()
            return remainder
        # Also check with comma/space after
        if lower.startswith(pattern + ",") or lower.startswith(pattern + " "):
            remainder = intent[len(pattern):].strip().lstrip(",").strip()
            return remainder
    return intent.strip()


async def execute_user_intent(tool_context: ToolContext, intent: str) -> dict:
    """The user wants something done. Pass their EXACT words here. Always call this immediately."""
    sid = tool_context.state.get("_session_id", "default")

    # Strip wake word from intent — conductor sometimes passes "Hej Lobster otwórz YouTube"
    clean_intent = _strip_wake_word(intent)
    if not clean_intent or len(clean_intent) < 3:
        return {"status": "ignored", "result": "That was just the wake word. Say 'Tak?' and wait for the user's actual command."}

    # Anti-garbage filter: require meaningful intent (2+ words, 8+ chars, Latin/Polish chars, looks like a command)
    _VALID_SHORT_COMMANDS = {"stop", "cancel", "pause", "resume", "help", "undo", "back", "anuluj", "cofnij", "pomoc", "open youtube", "open google", "open maps", "open map"}
    _word_count = len(clean_intent.split())
    _has_latin = bool(re.search(r'[a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ]{2,}', clean_intent))
    # Reject: too short, no Latin chars
    if len(clean_intent) < 5 or not _has_latin:
        return {"status": "ignored", "result": "Too short or garbled. Wait for a clear command."}
    if _word_count < 2 and len(clean_intent) < 6 and clean_intent.lower().strip() not in _VALID_SHORT_COMMANDS:
        return {"status": "ignored", "result": "Single word — not a task. Respond conversationally or stay silent."}
    # Reject: looks like echo/noise (common garbage patterns from voice)
    _lower = clean_intent.lower().strip()
    _GARBAGE_PATTERNS = [
        "hey, love", "love star", "you're a", "i'm a", "that's a", "it's a",
        "no, ale", "żeby się", "هلا", "مرحبا", "ها", "just a",
        "is that", "what's that", "oh my", "oh no", "let me",
        # Conductor self-talk (its own responses echoed back as intent)
        "słucham", "jasne", "okej", "no to", "gotowe", "zrobione", "rozumiem",
        "dobra", "spoko", "leci", "ogarniam", "mam to", "siema", "hej hej",
        "cześć", "czesc", "witam", "hejka", "siemka",
    ]
    if any(_lower.startswith(gp) or _lower == gp for gp in _GARBAGE_PATTERNS):
        return {"status": "ignored", "result": "Sounds like background noise. Wait for a clear command."}

    # Dedup: ignore duplicate calls within 3 seconds (conductor sometimes calls twice)
    now = time.time()
    last = _last_intent.get(sid)
    if last and last[0] == clean_intent and now - last[1] < 8.0:
        return {"status": "duplicate", "result": "Already processing this request. Wait for the result."}
    _last_intent[sid] = (clean_intent, now)

    # Fire-and-forget: router runs in background, conductor returns instantly
    asyncio.create_task(_master_router(sid, clean_intent))
    return {"status": "started", "result": "Task accepted. Say a SHORT confirmation (1-3 words) and STOP. Do NOT call any more tools."}


ROUTER_TOOLS = [activate_listening, execute_user_intent]


# ══════════════════════════════════════════════════════════════════════
# MASTER ROUTER — Gemini 3 Flash JSON classification (0-latency)
# Classifies intent → Python routes deterministically. No AI hallucination.
# ══════════════════════════════════════════════════════════════════════

async def _master_router(session_id: str, intent: str):
    """Classify user intent via Gemini 3 Flash JSON and route to correct handler."""
    global _api_calls_total
    try:
        _api_calls_session[session_id] = _api_calls_session.get(session_id, 0) + 1
        _api_calls_total += 1
        if _api_calls_total % 20 == 0:
            print(f"[COST] API calls total={_api_calls_total} session={_api_calls_session.get(session_id, 0)} (router)")
        response = await genai_client.aio.models.generate_content(
            model=ROUTER_MODEL,
            contents=[types.Content(role="user", parts=[types.Part(text=f"""Classify this user intent into a JSON object.

USER INTENT: "{intent}"

Return EXACTLY this JSON schema:
{{
  "category": "BROWSER" | "CREATIVE" | "RESEARCH" | "CRON" | "CANCEL_CRON" | "SWARM" | "DECOMPOSE" | "FIGMA",
  "task": "<clear task description in user's language>",
  "interval_seconds": <integer or null>,
  "target_url": "<url if mentioned or inferrable, else null>",
  "swarm_targets": ["<url1>", "<url2>", ...]
}}

Rules:
- "compare X on site1, site2, site3" / "find cheapest on Amazon, Allegro, MediaExpert" → SWARM with swarm_targets=[urls]
- "monitor/check X every N seconds" → CRON with interval_seconds=N
- "draw/sketch/paint/narysuj" or "excalidraw" → CREATIVE
- "search for/find/research/sprawdź" → RESEARCH
- "cancel monitoring/cron/recurring/anuluj" → CANCEL_CRON
- "design/build/create UI" + "figma" or "zaprojektuj UI/stronę/layout" → FIGMA with target_url="https://www.figma.com"
- DECOMPOSE: Complex multi-step goals that benefit from PARALLEL execution. User wants to achieve a big goal that can be broken into 2-4 independent sub-tasks running simultaneously. Examples: "research and compare X vs Y vs Z", "find best deals across sites", "gather info from multiple sources", "analyze competitors". Use DECOMPOSE when the goal is complex but user didn't specify exact URLs.
- Everything else (open, click, type, navigate, buy, email, write) → BROWSER
- SWARM = user wants to compare/search the SAME thing across MULTIPLE specific websites simultaneously. Include all URLs in swarm_targets.
- SWARM IMPORTANT: If user says "swarm"/"compare" but doesn't name specific sites, INFER them:
  - For products/prices → swarm_targets=["https://www.amazon.pl", "https://allegro.pl", "https://www.mediaexpert.pl", "https://www.x-kom.pl"]
  - For news → swarm_targets=["https://www.onet.pl", "https://tvn24.pl", "https://www.wp.pl"]
  - For reviews/opinions → swarm_targets=["https://www.google.com", "https://www.youtube.com", "https://www.reddit.com"]
  - NEVER return empty swarm_targets for SWARM category — always infer at least 3 URLs.
- FIGMA = user wants to design/build a UI, website, app layout, or visual design in Figma. Agent will navigate to Figma and build the design.
- Extract URL from context: "reddit" → "https://www.reddit.com", "youtube" → "https://www.youtube.com", "onet" → "https://www.onet.pl", "allegro" → "https://allegro.pl", "gmail" → "https://mail.google.com", "github" → "https://github.com"
- Subreddits: "r/technology" → "https://www.reddit.com/r/technology"
- If user says "every 20 seconds" → interval_seconds: 20. "every minute" / "co minutę" → 60. "every 30 seconds" / "co 30 sekund" → 30. NEVER default to 3600.
- For CRON category: interval_seconds is REQUIRED, NEVER null. If user doesn't specify exact interval, default to 60.
- Explicit URLs in intent: extract as-is
- Return ONLY valid JSON, no markdown, no explanation.""")])],
            config=types.GenerateContentConfig(
                temperature=0.0,
                response_mime_type="application/json",
            ),
        )

        result = json.loads(response.text.strip())
        category = result.get("category", "BROWSER")
        task = result.get("task", intent)
        interval = result.get("interval_seconds")
        target_url = result.get("target_url")

        print(f"[router] Intent: '{intent[:60]}' → {category} task='{task[:60]}' url={target_url} interval={interval}")

        # Hard Python routing — no AI hallucination possible
        if category == "CANCEL_CRON":
            cancelled = 0
            for jid, job in list(_cron_jobs.items()):
                if job["session_id"] == session_id:
                    t = job.get("asyncio_task")
                    if t and not t.done():
                        t.cancel()
                    _cron_jobs.pop(jid, None)
                    cancelled += 1
            live_queue = _live_queues.get(session_id)
            if live_queue:
                _handoff_pending[session_id] = True
                live_queue.send_content(types.Content(parts=[
                    types.Part(text=f"Task done: Cancelled {cancelled} recurring tasks. Tell the user.")
                ]))
            # Direct frontend fallback
            ws = _websockets.get(session_id)
            if ws:
                asyncio.ensure_future(ws.send_json({
                    "type": "transcript", "text": f"[Lobster]: Anulowano {cancelled} zadań cyklicznych.", "replace": False,
                }))
        elif category == "CRON":
            _schedule_cron_from_router(session_id, task, interval or 60, target_url)
        elif category == "SWARM":
            # Parallel executors on multiple tabs — "Tab Swarm"
            swarm_targets = result.get("swarm_targets", [])
            # Smart fallback: infer targets from task if router didn't extract URLs
            if not swarm_targets:
                _task_lower = task.lower()
                if any(w in _task_lower for w in ["cena", "price", "kup", "buy", "sklep", "shop", "produkt", "product", "ile kosztuje"]):
                    _q = quote_plus(task)
                    swarm_targets = [
                        f"https://www.google.com/search?q={_q}",
                        f"https://allegro.pl/listing?string={_q}",
                        f"https://www.amazon.pl/s?k={_q}",
                    ]
                elif any(w in _task_lower for w in ["news", "wiadomości", "informacje", "artykuły"]):
                    swarm_targets = ["https://www.onet.pl", "https://tvn24.pl", "https://www.wp.pl"]
                else:
                    # Generic: search on multiple engines
                    _q = quote_plus(task)
                    swarm_targets = [
                        f"https://www.google.com/search?q={_q}",
                        f"https://www.bing.com/search?q={_q}",
                        f"https://duckduckgo.com/?q={_q}",
                    ]
            _launch_swarm(session_id, task, swarm_targets)
        elif category == "DECOMPOSE":
            asyncio.create_task(_decompose_and_swarm(session_id, task))
        elif category == "FIGMA":
            _start_executor(session_id, task, "figma", target_url=target_url or "https://www.figma.com")
        else:
            # BROWSER, CREATIVE, RESEARCH → all go to executor
            _start_executor(session_id, task, category.lower(), target_url=target_url)

    except Exception as e:
        print(f"[router] Error classifying intent: {e}")
        traceback.print_exc()
        # Fallback: treat everything as browser task
        _start_executor(session_id, intent, "browser")


def _schedule_cron_from_router(session_id: str, task: str, interval: int, target_url: str | None):
    """Schedule cron job from router result. Pure Python, no AI decisions."""
    # Dedup: skip if same task was scheduled within last 15s (voice fallback can double-fire)
    for j in _cron_jobs.values():
        if j["session_id"] == session_id and j["task"].strip().lower() == task.strip().lower():
            age = time.time() - j.get("created_at", 0)
            if age < 15:
                print(f"[cron] Skipping duplicate: '{task[:40]}' (scheduled {age:.1f}s ago)")
                return
    session_jobs = [j for j in _cron_jobs.values() if j["session_id"] == session_id]
    if len(session_jobs) >= 5:
        live_queue = _live_queues.get(session_id)
        if live_queue:
            _handoff_pending[session_id] = True
            live_queue.send_content(types.Content(parts=[
                types.Part(text="Task done: Maximum 5 recurring tasks. Cancel one first.")
            ]))
        return
    interval = max(10, int(interval))  # Min 10s for demo mode
    job_id = f"cron_{_uuid.uuid4().hex[:8]}"
    _cron_jobs[job_id] = {
        "session_id": session_id,
        "task": task,
        "interval": interval,
        "category": "browser",
        "last_result": None,
        "created_at": time.time(),
        **({"url": target_url, "base_url": target_url} if target_url else {}),
    }
    _cron_jobs[job_id]["asyncio_task"] = asyncio.create_task(_run_cron_job(job_id))
    # Notify Conductor
    live_queue = _live_queues.get(session_id)
    if live_queue:
        _handoff_pending[session_id] = True
        live_queue.send_content(types.Content(parts=[
            types.Part(text=f"Task done: Scheduled '{task}' every {interval} seconds. Tell the user.")
        ]))
    # Notify frontend — direct transcript + cron status
    ws = _websockets.get(session_id)
    if ws:
        asyncio.ensure_future(ws.send_json({
            "type": "transcript", "text": f"[Lobster]: Zaplanowano '{task}' co {interval}s.", "replace": False,
        }))
        asyncio.ensure_future(ws.send_json({
            "type": "cron_update", "job_id": job_id,
            "status": "started", "task": task, "interval": interval,
            **({"url": target_url} if target_url else {}),
        }))


# ── Tab Swarm — parallel executors across multiple tabs ──

def _launch_swarm(session_id: str, task: str, targets: list[str]):
    """Launch parallel executor tasks on multiple URLs — Tab Swarm mode."""
    print(f"[swarm] Launching {len(targets)} parallel executors for: {task[:60]}")
    swarm_id = f"swarm_{_uuid.uuid4().hex[:6]}"
    swarm_tasks = []

    for i, url in enumerate(targets[:5]):  # Max 5 parallel tabs
        task_desc = f"{task} (on {url})"
        tid = _start_executor(session_id, task_desc, "research", target_url=url)
        swarm_tasks.append(tid)
        print(f"[swarm] Tab {i+1}: {url} → {tid}")

    # Track swarm for aggregation
    _swarm_tracker[swarm_id] = {
        "session_id": session_id,
        "task": task,
        "targets": targets,
        "task_ids": swarm_tasks,
        "results": {},
        "started_at": time.time(),
    }

    # Notify conductor
    live_queue = _live_queues.get(session_id)
    if live_queue:
        live_queue.send_content(types.Content(parts=[
            types.Part(text=f"Launched Tab Swarm: {len(targets)} parallel browser agents working on '{task}' across {', '.join(targets[:3])}. Results coming soon.")
        ]))

    # Notify frontend
    ws = _websockets.get(session_id)
    if ws:
        asyncio.ensure_future(ws.send_json({
            "type": "transcript",
            "text": f"[Lobster]: Tab Swarm aktywny — {len(targets)} agentów pracuje równolegle!",
            "replace": False,
        }))
        asyncio.ensure_future(ws.send_json({
            "type": "swarm_status",
            "swarm_id": swarm_id,
            "status": "active",
            "subtasks": [{"task": f"{task} (on {url})", "url": url, "taskId": tid, "status": "running"}
                         for url, tid in zip(targets, swarm_tasks)],
        }))


# ── Swarm Decomposer — LLM breaks complex goals into parallel sub-tasks ──

async def _decompose_and_swarm(session_id: str, complex_goal: str):
    """Use LLM to break a complex goal into 2-4 parallel sub-tasks, then launch as swarm."""
    global _api_calls_total
    try:
        _api_calls_total += 1
        _api_calls_session[session_id] = _api_calls_session.get(session_id, 0) + 1
        print(f"[decomposer] Breaking down: {complex_goal[:80]}")

        response = await genai_client.aio.models.generate_content(
            model=ROUTER_MODEL,
            contents=[types.Content(role="user", parts=[types.Part(text=f"""Break this complex goal into 2-4 PARALLEL sub-tasks that can run simultaneously in separate browser tabs.

GOAL: "{complex_goal}"

Each sub-task should:
1. Be independent (can run without waiting for others)
2. Have a clear target URL to start from
3. Contribute to solving the overall goal

Return EXACTLY this JSON:
{{
  "subtasks": [
    {{"task": "<specific task description>", "target_url": "https://..."}},
    {{"task": "<specific task description>", "target_url": "https://..."}}
  ],
  "aggregation_prompt": "<how to combine all results into a final answer>"
}}

URL inference rules:
- Product/price research → google.com, allegro.pl, amazon.pl, ceneo.pl
- News → onet.pl, tvn24.pl, wp.pl
- Reviews → reddit.com, youtube.com, trustpilot.com
- Social media → specific platform URLs
- General research → google.com with different search queries

Return ONLY valid JSON.""")])],
            config=types.GenerateContentConfig(
                temperature=0.2,
                response_mime_type="application/json",
            ),
        )

        result = json.loads(response.text.strip())
        subtasks = result.get("subtasks", [])
        aggregation_prompt = result.get("aggregation_prompt", "Combine all findings into a summary.")

        if not subtasks or len(subtasks) < 2:
            # Not decomposable — run as single task
            print(f"[decomposer] Not decomposable, running as single task")
            _start_executor(session_id, complex_goal, "browser")
            return

        # Launch as swarm with sub-tasks
        targets = [st.get("target_url", "https://www.google.com") for st in subtasks]
        task_descs = [st.get("task", complex_goal) for st in subtasks]

        swarm_id = f"swarm_{_uuid.uuid4().hex[:6]}"
        swarm_tasks = []
        for i, (desc, url) in enumerate(zip(task_descs, targets)):
            tid = _start_executor(session_id, desc, "research", target_url=url)
            swarm_tasks.append(tid)
            print(f"[decomposer] Sub-task {i+1}: {desc[:60]} → {url[:40]} → {tid}")

        _swarm_tracker[swarm_id] = {
            "session_id": session_id,
            "task": complex_goal,
            "targets": targets,
            "subtask_descs": task_descs,
            "task_ids": swarm_tasks,
            "results": {},
            "aggregation_prompt": aggregation_prompt,
            "started_at": time.time(),
        }

        # Notify conductor
        live_queue = _live_queues.get(session_id)
        if live_queue:
            live_queue.send_content(types.Content(parts=[
                types.Part(text=f"Swarm Decomposer activated: Broke '{complex_goal[:60]}' into {len(subtasks)} parallel sub-tasks. Agents are working now.")
            ]))

        # Notify frontend
        ws = _websockets.get(session_id)
        if ws:
            try:
                await ws.send_json({
                    "type": "transcript",
                    "text": f"[Lobster]: Swarm Decomposer — rozbito zadanie na {len(subtasks)} równoległych podzadań!",
                    "replace": False,
                })
                await ws.send_json({
                    "type": "swarm_status",
                    "swarm_id": swarm_id,
                    "status": "active",
                    "subtasks": [{"task": d, "url": u, "task_id": t, "status": "running"}
                                 for d, u, t in zip(task_descs, targets, swarm_tasks)],
                })
            except Exception:
                pass

    except Exception as e:
        print(f"[decomposer] Error: {e}")
        traceback.print_exc()
        # Fallback: run as single task
        _start_executor(session_id, complex_goal, "browser")


# ══════════════════════════════════════════════════════════════════════
# BRAIN 2: EXECUTOR — Background Browser Worker (Gemini Standard API)
# Has vision (screenshots), all browser tools, runs multi-step tasks.
# ══════════════════════════════════════════════════════════════════════

EXECUTOR_INSTRUCTION = """You are an elite autonomous browser agent with VISION. You see the browser via screenshots AND have a structured element map with reference IDs for precise interaction.

QUALITY MINDSET — WOW EFFECT:
- You are being judged in a HACKATHON. Every task must produce the BEST POSSIBLE result.
- Use ALL the steps you need. Don't rush — take 15-20 steps if needed for perfect results.
- For DRAWING: add details! Eyes, whiskers, shading, labels, decorations. More strokes = better art.
- For BROWSING: be thorough. Read the full page, extract all relevant info, navigate deeper if needed.
- For WRITING: craft quality text. No placeholder content — write real, contextual, impressive responses.
- VERIFY everything via screenshots. If something doesn't look right, FIX IT before calling done().
- Your goal is to make the human watching say "WOW, that's impressive!" — not just "it works."

ReAct REASONING — MANDATORY FOR EVERY STEP:
Before EVERY action, you MUST think out loud:
1. OBSERVE: "I see [describe what's on screen and in the element map]"
2. THINK: "My goal is X. To get closer, I need to Y. I can see element #N which is Z."
3. ACT: Call the appropriate tool.
This reasoning helps you stay on track for multi-step tasks. NEVER skip it.

GOAL TRACKING:
- After each action, re-evaluate: "Am I closer to the goal? What's the next step?"
- If you don't see the element you need, SCROLL down and check the new element map.
- NEVER stop until the GOAL is FULLY achieved or you hit an insurmountable blocker (login wall, CAPTCHA).
- If something didn't work, try a DIFFERENT approach — don't repeat the same failing action.

YOU HAVE EYES + ELEMENT MAP:
- Every message includes a SCREENSHOT — LOOK AT IT. The image preserves aspect ratio (max dimension 768px).
- You also get [PAGE ELEMENTS] with numbered references (#0, #1, #2...) for every interactive element.
- After each action, you get a NEW screenshot + fresh element map.
- NEVER say "I can't see the screen" — you CAN see it.

TOOLS (in order of preference):

PRIMARY — Ref-based (100% accurate, use these FIRST):
1. click_by_ref(ref=N) — Click element by its #N reference ID from PAGE ELEMENTS. MOST RELIABLE.
2. type_into_ref(ref=N, text="...") — Type into input/textarea by ref ID. Works with React/Angular/Vue.
3. wait_for(condition, target) — Wait for page_load, network_idle, element_visible, or text_visible.

SECONDARY — JavaScript (for complex DOM operations):
4. execute_js(code) — Run JS for: reading page content, extracting data, complex multi-field forms.
5. navigate(url) — Go to a URL.

FALLBACK — Physical actions (for canvas/drawing/iframes):
6. click(x, y) — Click at screenshot coordinates. ONLY for canvas apps or when ref-click fails.
7. type_text(text) — Type via keyboard. ONLY when element has no ref ID (Shadow DOM, iframes).
8. press_key(key) — Press a key (Enter, Tab, Escape, Backspace, etc.).
9. scroll(direction) — Scroll 'up' or 'down'.
10. drag(from_x, from_y, to_x, to_y) — Drag from A to B.
11. draw_path(points, description) — Draw through multiple points [{x,y},...].
12. done(summary) — Signal completion. ONLY after visual verification.

WHEN TO USE WHAT:
- Button/link clicks → click_by_ref(ref=N) — find the element in PAGE ELEMENTS, use its #N
- Form inputs → type_into_ref(ref=N, text="...") — targets exact field by ref ID
- Reading page content → execute_js (return innerText, extract data)
- After navigation → wait_for("page_load") or wait_for("network_idle") before acting
- Drawing/sketching → drag or draw_path (REAL mouse events needed for canvas)
- Canvas apps (Excalidraw, Paint) → click(x,y) + drag + draw_path
- Shadow DOM / iframes → click(x,y) + type_text (native bypass when refs unavailable)

DRAWING vs GENERATING — CRITICAL DISTINCTION:
- User says "draw/sketch/doodle/narysuj/naszkicuj" + canvas app open (Excalidraw, sketch.io, tldraw, canvas) → use draw_path tool with REAL mouse strokes on the canvas
- User says "generate/create image/wygeneruj/stworz obrazek" → use generate_image tool (AI image generation)
- On canvas/drawing app: DEFAULT to draw_path UNLESS user explicitly says "generate/wygeneruj"
- NOT on canvas app: DEFAULT to generate_image
- NEVER use generate_image when user clearly wants cursor drawing on an existing canvas
- NEVER use draw_path when user wants AI-generated image

IMPORTANT — PREFER REF-BASED TOOLS OVER JS:
- Instead of execute_js to click a button → use click_by_ref(ref=N) from PAGE ELEMENTS
- Instead of execute_js to fill an input → use type_into_ref(ref=N, text="...")
- Use execute_js ONLY for: reading page content, extracting data, complex multi-element operations

JS PATTERNS — FOR READING/EXTRACTING (not clicking/typing):

// Click a button/link by visible text (ONLY if no ref ID available)
(function(){
  var el = [...document.querySelectorAll('a, button, [role="button"], input[type="submit"]')]
    .find(e => e.textContent.trim().includes('BUTTON_TEXT'));
  if (el) { el.click(); return 'Clicked: ' + el.textContent.trim().substring(0,50); }
  return 'Element not found';
})()

// Fill an input field (ONLY if type_into_ref doesn't work)
(function(){
  var el = document.querySelector('INPUT_SELECTOR');
  if (!el) return 'Input not found';
  var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, 'VALUE_HERE');
  el.dispatchEvent(new Event('input', {bubbles: true}));
  el.dispatchEvent(new Event('change', {bubbles: true}));
  return 'Filled: ' + el.value.substring(0,50);
})()

// Fill MULTIPLE form fields at once
(function(){
  var fields = {
    '#email': 'user@example.com',
    '#password': 'mypassword',
    'input[name="username"]': 'johndoe'
  };
  var filled = 0;
  for (var sel in fields) {
    var el = document.querySelector(sel);
    if (el) {
      var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, fields[sel]);
      el.dispatchEvent(new Event('input', {bubbles: true}));
      el.dispatchEvent(new Event('change', {bubbles: true}));
      filled++;
    }
  }
  return 'Filled ' + filled + ' fields';
})()

// Read page content as text
(function(){
  var main = document.querySelector('main, article, [role="main"], .content, #content') || document.body;
  return main.innerText.substring(0, 10000);
})()

// Extract structured data (e.g. search results)
(function(){
  var results = [...document.querySelectorAll('div.g, div[data-hveid]')].slice(0, 10).map(function(el) {
    var a = el.querySelector('a[href]');
    var h3 = el.querySelector('h3');
    var snippet = el.querySelector('.VwiC3b, [data-sncf]');
    return { title: h3 ? h3.textContent : '', url: a ? a.href : '', snippet: snippet ? snippet.textContent : '' };
  }).filter(function(r) { return r.title && r.url; });
  return JSON.stringify(results);
})()

// Scroll down
window.scrollBy(0, 600); return 'Scrolled down';

// Press a key (Enter, Tab, Escape, etc.)
(function(){
  var el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true}));
  el.dispatchEvent(new KeyboardEvent('keyup', {key: 'Enter', code: 'Enter', bubbles: true}));
  return 'Pressed Enter';
})()

// Select dropdown option
(function(){
  var sel = document.querySelector('SELECT_SELECTOR');
  if (!sel) return 'Dropdown not found';
  sel.value = 'OPTION_VALUE';
  sel.dispatchEvent(new Event('change', {bubbles: true}));
  return 'Selected: ' + sel.value;
})()

// Write into contentEditable (Google Docs, rich editors, etc.)
(function(){
  var editor = document.querySelector('[contenteditable="true"], .ProseMirror, .ql-editor, [role="textbox"]');
  if (!editor) return 'No editor found';
  editor.focus();
  editor.innerHTML = 'YOUR_CONTENT_HERE';
  editor.dispatchEvent(new Event('input', {bubbles: true}));
  return 'Content written: ' + editor.textContent.substring(0, 50);
})()

// Shadow DOM / Web Components (Reddit shreddit-*, modern SPAs)
// Some sites use Web Components with Shadow DOM — regular querySelector CANNOT reach inside.
// Strategy: try shadowRoot access first, fall back to native click + type_text
(function(){
  var host = document.querySelector('shreddit-composer, [data-testid="comment-composer"]');
  if (host && host.shadowRoot) {
    var editor = host.shadowRoot.querySelector('[contenteditable="true"], textarea, [role="textbox"]');
    if (editor) { editor.focus(); editor.textContent = 'YOUR_TEXT'; return 'Filled via shadowRoot'; }
  }
  // Fallback: find any visible contenteditable/textbox on page
  var fallback = document.querySelector('[contenteditable="true"]:not([aria-hidden]), [role="textbox"]:not([aria-hidden])');
  if (fallback) { fallback.focus(); fallback.textContent = 'YOUR_TEXT'; return 'Filled via fallback'; }
  return 'No editor found — use native click() + type_text() instead';
})()

WHEN JS FORM FILLING DOESN'T WORK (Shadow DOM, iframes, web components):
- If execute_js can't find or fill a text field, switch to NATIVE actions:
  1. click(x, y) on the text field (use screenshot coordinates) — this gives it real focus
  2. type_text("your text") — types via real keyboard events, bypasses Shadow DOM completely
  3. click(x, y) on the Submit/Post button
- This works for: Reddit comments, Slack messages, Discord chat, any Shadow DOM input
- ALWAYS try JS first (faster), but if it returns "not found" or the text doesn't appear, switch to native click + type_text

// Dismiss cookie banners
(function(){
  var btns = [...document.querySelectorAll('button, [role="button"], a')];
  var cookie = btns.find(function(b) {
    var t = b.textContent.toLowerCase();
    return t.includes('accept') || t.includes('agree') || t.includes('ok') || t.includes('got it') || t.includes('zgadzam') || t.includes('akceptuj');
  });
  if (cookie) { cookie.click(); return 'Dismissed cookie banner'; }
  return 'No cookie banner found';
})()

RESEARCH STRATEGY:
1. navigate("https://www.google.com/search?q=YOUR+QUERY")
2. execute_js → scrape search result titles + URLs + snippets (use pattern above)
3. navigate to the best/most relevant result
4. execute_js → extract page content as text/markdown
5. Repeat for 2-3 more results if needed
6. Synthesize all findings → call done(summary)

FORM FILLING STRATEGY:
1. execute_js → survey the page: return all form fields with selectors, types, labels
2. execute_js → fill ALL fields at once in a single call (use multi-field pattern)
3. execute_js → click the submit/send button
4. Verify result via screenshot → done(summary)

WRITING / ESSAY STRATEGY:
1. navigate to the target (Google Docs, notepad site, or current page editor)
2. execute_js → find the editor/textarea, write the FULL content directly
3. Verify result → done(summary)

DRAWING vs GENERATING — TWO COMPLETELY DIFFERENT THINGS:

GENERATE (wygeneruj, stwórz obraz, generate image, create picture):
- Use generate_image(prompt="detailed description", inject_mode="overlay")
- ALWAYS use inject_mode="overlay" — NEVER "excalidraw"
- This opens a Gallery tab with the generated image
- Use when user says: "wygeneruj", "stwórz obraz", "generate", "create a picture/photo"

DRAW / PAINT (narysuj, namaluj, draw, paint, sketch):
- Use drag(), draw_path(), press_key() — ACTUAL MOUSE CURSOR drawing on canvas
- Use when user says: "narysuj", "namaluj", "draw", "paint", "sketch"
- Draw on Excalidraw, Sketchpad, MS Paint, or any canvas app
- Use MANY draw_path calls with 30-50 points each for detailed, beautiful drawings
- This is MANUAL drawing with the mouse — NOT AI generation

MANUAL DRAWING STRATEGY (Excalidraw, Canvas, Paint):
1. navigate to the canvas app if not already there
2. Look at the screenshot — identify the canvas area and available tools in the toolbar
3. Click on the CANVAS AREA first to ensure the app has focus (shortcuts only work when focused)
4. Select the drawing tool:
   EXCALIDRAW SHORTCUTS (MUST have canvas focus first):
     1=Select/Move, 2=Rectangle, 3=Diamond, 4=Ellipse, 5=Arrow, 6=Line, 7=Freedraw/Pencil, 0=Eraser
   - For freehand drawing: press_key("7") — this is FREEDRAW, NOT "6" (that's Line tool!)
   - For shapes: press_key("2") for rectangle, press_key("4") for ellipse
   - For straight lines: press_key("6")
   OTHER CANVAS APPS: click the tool icon directly in the toolbar
5. CRITICAL — VERIFY TOOL SELECTION: Look at the screenshot. Check the toolbar — is your tool highlighted/active?
   - If the tool did NOT change: click the tool ICON directly in the toolbar instead of using shortcut
   - Do NOT draw until you CONFIRM the correct tool is active in the toolbar
6. PLAN YOUR DRAWING FIRST — break subject into parts (head, body, legs, ears, tail, eyes, etc.)
   - Calculate proportions on the 768x768 grid
   - Each body part = one draw_path call
7. Draw with MANY DETAILED POINTS — this is critical for quality:
   - Use 30-50 points per stroke — closely spaced (every 5-10px) for curves
   - For circles/ovals (r=50): use 25+ evenly spaced points around the arc
     Example: [{x:450,y:300},{x:448,y:315},{x:443,y:330},{x:435,y:343},{x:425,y:350},{x:413,y:348},{x:400,y:350},{x:388,y:348},{x:375,y:343},{x:365,y:330},{x:360,y:315},{x:358,y:300},{x:360,y:285},{x:365,y:270},{x:375,y:258},{x:388,y:252},{x:400,y:250},{x:413,y:252},{x:425,y:258},{x:435,y:270},{x:443,y:285},{x:448,y:295},{x:450,y:300}]
   - For organic curves (animal body): space points every 5px along the curve
   - WRONG: 5 points for a circle → looks like a pentagon
   - RIGHT: 25+ points for a circle → looks smooth and beautiful
8. After EACH stroke: look at screenshot → verify it appeared
   - If nothing appeared: go back to step 3 (tool wasn't selected properly)
   - After body outline → add ears, eyes, nose, mouth as separate strokes
9. Add details: eyes (small circles), nose (triangle), whiskers (lines), shading. Each = separate draw_path.
10. done(summary)

COORDINATE TIPS:
- Screenshot preserves aspect ratio (max dimension ~768px). Actual size varies (e.g. 768x432 for widescreen).
- Top-left = (0,0). Look at the screenshot to estimate positions visually.
- For drawing: plan your strokes as coordinate sequences.

RULES:
- PREFER click_by_ref/type_into_ref for DOM interactions (100% accurate via element map)
- USE native actions (click, drag, draw_path) for CANVAS/DRAWING/DRAG-AND-DROP — these need physical mouse events
- For DRAWING: use MANY draw_path calls with 30-50 points each. More points = smoother = BETTER drawing quality.
- ALWAYS return a value from execute_js
- Be EFFICIENT: do as much as possible per step
- For login/CAPTCHA: done("Needs user login — cannot proceed")
- Use [PAGE ELEMENTS] #IDs for clicking and typing — they're always accurate
- BACKGROUND WORK: You work in YOUR OWN TAB — do NOT switch the user's active tab.

IDENTITY:
- You ARE Lobster — a friendly red lobster mascot. If asked for a selfie, generate an image of yourself as a cute red lobster character.

**PLAN BEFORE ACTING — THINK STEP BY STEP**:
For EVERY task, first reason about the logical steps:
- "Send message to X on LinkedIn" → 1) Navigate to LinkedIn, 2) Search for X, 3) Open their profile, 4) Click Message button, 5) Wait for chat to open, 6) Click the message INPUT field specifically, 7) Type message, 8) Click Send, 9) Verify sent
- DON'T skip steps. DON'T assume. VERIFY after each step.
- If a step fails, try a different approach before moving on.

**CRITICAL — TYPING INTO THE CORRECT FIELD**:
This is the #1 most common mistake. BEFORE typing:
1. READ the PAGE ELEMENTS list — find the correct input by its label/placeholder/name
2. CLICK that specific element by ref FIRST (click_by_ref) to give it focus
3. VERIFY in the screenshot that the cursor is blinking in the CORRECT field
4. ONLY THEN use type_into_ref to type into that same ref ID
5. If text appears in the WRONG field (search bar, URL bar, etc.) → STOP, press Escape, click the correct field
- LinkedIn: the search bar at the top grabs focus by default — you MUST click the message input field first
- Gmail: "To" field grabs focus — click the body area before typing the message
- Social media: click the post/comment textarea before typing

**VERIFICATION IS MANDATORY**:
Before calling done(), you MUST:
1. Look at the FINAL screenshot carefully
2. Confirm the action ACTUALLY happened (sent confirmation, posted text visible, etc.)
3. If you see no confirmation → it didn't work. Try again.
4. NEVER claim success based on what you TRIED — only what the screenshot SHOWS.

SITE NAVIGATION — USE YOUR EYES, NOT RECIPES:
- Do NOT follow memorized steps. Every site changes. USE YOUR VISION + PAGE ELEMENTS.
- GENERAL STRATEGY for messaging/compose tasks:
  1. Navigate to the right page (search for person, find compose area)
  2. LOOK at screenshot — find the Message/Compose button visually or in PAGE ELEMENTS
  3. Click it and WAIT for the input area to appear (use wait_for if needed)
  4. Re-read PAGE ELEMENTS — find the message input field (contentEditable, textarea, etc.)
  5. click_by_ref on that specific field FIRST, then type_into_ref or execute_js to write
  6. VERIFY text is in the correct field (not search bar, not URL bar)
  7. Find Send/Submit button → click → VERIFY success
- If STUCK 3+ steps: STOP, re-read screenshot + element map, try a DIFFERENT approach
- If popup/overlay blocks: close first (Escape, click X, dismiss cookies)
- NEVER click random elements. NEVER guess. Always READ the screenshot and element map.

AFTER EACH ACTION:
- You receive a fresh screenshot + fresh [PAGE ELEMENTS] map.
- VERIFY your action worked visually. Check the screenshot!
- If something didn't work → try a DIFFERENT approach (different tool, different element, scroll first).
- Use the #N reference IDs from PAGE ELEMENTS — they're refreshed every step and always accurate."""


# ── Executor Tool Declarations (HYBRID: JS + native input events) ──

HYBRID_TOOLS = types.Tool(function_declarations=[
    # ── JS power tool ──
    types.FunctionDeclaration(
        name="execute_js",
        description="Execute JavaScript in the browser tab. Use for: reading page content, clicking buttons by text/selector, filling forms, extracting data, manipulating DOM. Returns result (up to 15KB). PREFER this for most interactions — it's faster and more reliable than coordinate-based actions.",
        parameters=types.Schema(type="OBJECT", properties={
            "code": types.Schema(type="STRING", description="JS code to run. MUST return a value. Wrap async in (async function(){...})()")
        }, required=["code"])
    ),
    # ── Navigation ──
    types.FunctionDeclaration(
        name="navigate",
        description="Navigate to a URL. Use for cross-origin navigation.",
        parameters=types.Schema(type="OBJECT", properties={
            "url": types.Schema(type="STRING", description="Full URL (https://...)")
        }, required=["url"])
    ),
    # ── Physical mouse actions (use screenshot coordinates, 768x768 grid) ──
    types.FunctionDeclaration(
        name="click",
        description="Click at screen coordinates. Use ONLY when execute_js click doesn't work (canvas apps, iframes, complex overlays). Coordinates are on the 768x768 screenshot grid.",
        parameters=types.Schema(type="OBJECT", properties={
            "x": types.Schema(type="INTEGER", description="X coordinate (0-768)"),
            "y": types.Schema(type="INTEGER", description="Y coordinate (0-768)"),
        }, required=["x", "y"])
    ),
    types.FunctionDeclaration(
        name="type_text",
        description="Type text using the keyboard into the currently focused element. Use after clicking an input field.",
        parameters=types.Schema(type="OBJECT", properties={
            "text": types.Schema(type="STRING", description="Text to type"),
        }, required=["text"])
    ),
    types.FunctionDeclaration(
        name="press_key",
        description="Press a keyboard key (Enter, Tab, Escape, Backspace, Delete, ArrowDown, ArrowUp, etc.).",
        parameters=types.Schema(type="OBJECT", properties={
            "key": types.Schema(type="STRING", description="Key name: Enter, Tab, Escape, Backspace, Delete, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Space, a-z, etc."),
        }, required=["key"])
    ),
    types.FunctionDeclaration(
        name="scroll",
        description="Scroll the page up or down.",
        parameters=types.Schema(type="OBJECT", properties={
            "direction": types.Schema(type="STRING", description="'up' or 'down'"),
        }, required=["direction"])
    ),
    types.FunctionDeclaration(
        name="drag",
        description="Click and drag from one point to another. Use for: drawing lines, moving objects, resizing, sliders. Coordinates on 768x768 grid.",
        parameters=types.Schema(type="OBJECT", properties={
            "from_x": types.Schema(type="INTEGER", description="Start X (0-768)"),
            "from_y": types.Schema(type="INTEGER", description="Start Y (0-768)"),
            "to_x": types.Schema(type="INTEGER", description="End X (0-768)"),
            "to_y": types.Schema(type="INTEGER", description="End Y (0-768)"),
            "description": types.Schema(type="STRING", description="What this drag does (e.g. 'draw line', 'move element')"),
        }, required=["from_x", "from_y", "to_x", "to_y"])
    ),
    types.FunctionDeclaration(
        name="draw_path",
        description="Draw a complex path through multiple points. Use for: freehand drawing, sketching shapes, signatures. Coordinates on 768x768 grid. Points are connected smoothly with visible cursor movement.",
        parameters=types.Schema(type="OBJECT", properties={
            "points": types.Schema(type="ARRAY", items=types.Schema(type="OBJECT", properties={
                "x": types.Schema(type="INTEGER"), "y": types.Schema(type="INTEGER"),
            }), description="Array of {x, y} points to draw through. Minimum 2 points."),
            "description": types.Schema(type="STRING", description="What this draws (e.g. 'circle', 'heart shape', 'letter A')"),
        }, required=["points"])
    ),
    # ── Ref-based actions (PREFERRED — use element map #IDs) ──
    types.FunctionDeclaration(
        name="click_by_ref",
        description="Click an interactive element by its reference ID from [PAGE ELEMENTS]. MOST RELIABLE click method — use this instead of click(x,y) whenever possible. Use the #N numbers.",
        parameters=types.Schema(type="OBJECT", properties={
            "ref": types.Schema(type="INTEGER", description="Element reference ID (the # number from PAGE ELEMENTS)"),
        }, required=["ref"])
    ),
    types.FunctionDeclaration(
        name="type_into_ref",
        description="Focus an input/textarea by reference ID and type text into it. Works with React/Angular/Vue. Use the #N numbers from [PAGE ELEMENTS]. Prefer this over type_text() as it targets the exact element.",
        parameters=types.Schema(type="OBJECT", properties={
            "ref": types.Schema(type="INTEGER", description="Element reference ID (the # number)"),
            "text": types.Schema(type="STRING", description="Text to type into the element"),
        }, required=["ref", "text"])
    ),
    # ── Smart waiting ──
    types.FunctionDeclaration(
        name="wait_for",
        description="Wait for a condition before proceeding. Use after navigation or clicks that trigger page loads, AJAX requests, or dynamic content rendering.",
        parameters=types.Schema(type="OBJECT", properties={
            "condition": types.Schema(type="STRING", description="What to wait for: 'page_load', 'network_idle', 'element_visible', 'text_visible'"),
            "target": types.Schema(type="STRING", description="CSS selector (for element_visible) or text string (for text_visible). Not needed for page_load/network_idle."),
            "timeout": types.Schema(type="INTEGER", description="Max wait in seconds (default 5, max 15)"),
        }, required=["condition"])
    ),
    # ── Image generation (PRO drawing — replaces mouse sketching) ──
    types.FunctionDeclaration(
        name="generate_image",
        description="Generate a high-quality image using AI (Gemini Imagen) and inject it into the current page. Use this instead of draw_path when the user wants a detailed picture, illustration, painting, or any complex visual. The image appears instantly on the page — FAR better than mouse drawing. For Excalidraw: injects as embedded image element. For other pages: injects as centered overlay.",
        parameters=types.Schema(type="OBJECT", properties={
            "prompt": types.Schema(type="STRING", description="Detailed description of the image to generate. Be specific: style, colors, composition, subject, mood."),
            "inject_mode": types.Schema(type="STRING", description="How to inject: 'overlay' (centered on page + added to Gallery tab). ALWAYS use 'overlay'. For drawing on canvas, use draw_path() instead."),
        }, required=["prompt"])
    ),
    # ── Hive Memory (shared state across agents) ──
    types.FunctionDeclaration(
        name="write_to_hive",
        description="Store a finding/result in shared Hive Memory for other agents to use. Use to save extracted data (prices, text, URLs) that other parallel agents or future cron ticks can access.",
        parameters=types.Schema(type="OBJECT", properties={
            "key": types.Schema(type="STRING", description="Memory key (e.g. 'amazon_price', 'reddit_top_post', 'search_result')"),
            "value": types.Schema(type="STRING", description="The data to store (text, number, URL, etc.)"),
        }, required=["key", "value"])
    ),
    types.FunctionDeclaration(
        name="read_from_hive",
        description="Read a value from shared Hive Memory written by any agent. Use key='*' to see all stored data.",
        parameters=types.Schema(type="OBJECT", properties={
            "key": types.Schema(type="STRING", description="Memory key to read, or '*' for all entries"),
        }, required=["key"])
    ),
    # ── Completion ──
    types.FunctionDeclaration(
        name="done",
        description="Signal task completion. MANDATORY: Look at the CURRENT screenshot and confirm the task result is VISIBLE (e.g., sent confirmation, page loaded, form submitted). If you cannot visually confirm success, do NOT call done — take corrective action instead. For swarm tasks: ALWAYS write_to_hive() with your findings BEFORE calling done().",
        parameters=types.Schema(type="OBJECT", properties={
            "summary": types.Schema(type="STRING", description="Brief summary of what was accomplished")
        }, required=["summary"])
    ),
])


# ── Direct action sender (bypasses ADK ToolContext for Executor) ──

async def _send_action_direct(session_id: str, action: dict, timeout: float = 8.0, task_id: str | None = None) -> dict:
    """Send action to Electron and wait for result. Routes via task_id for multi-tab."""
    ws = _websockets.get(session_id)

    if not ws:
        return {"status": "error", "message": "No WebSocket connection"}

    # Use per-task result queue if task_id provided
    q_result = _task_result_queues.get(task_id) if task_id else _result_queues.get(session_id)

    try:
        msg = {"type": "action", **action}
        if task_id:
            msg["task_id"] = task_id
        await ws.send_json(msg)
    except Exception as e:
        return {"status": "error", "message": f"Send failed: {e}"}

    if q_result:
        try:
            result = await asyncio.wait_for(q_result.get(), timeout=timeout)
            # Use per-task element map if available, fall back to session-level
            elems = _task_element_maps.get(task_id, []) if task_id else _element_maps.get(session_id, [])
            if not elems:
                elems = _element_maps.get(session_id, [])
            if elems:
                result["_page_elements"] = _format_element_map_for_model(elems)
            return result
        except asyncio.TimeoutError:
            return {"status": "timeout", "message": f"Timed out after {timeout}s"}

    return {"status": "error", "message": "No result queue"}


# ── read_page_as_markdown JS (reused from skills) ──
_MARKDOWN_JS = r"""(function(){var noise=document.querySelectorAll('nav,header,footer,aside,[role="banner"],[role="navigation"],[role="complementary"],.sidebar,.nav,.footer,.header,.menu,.ad,.ads,.cookie,script,style,noscript,svg');noise.forEach(function(el){});var main=document.querySelector('main,article,[role="main"],.post-content,.article-body,.entry-content,#content,.content');var target=main||document.body;function toMd(el,d){if(!el||el.nodeType===8)return'';if(el.nodeType===3)return el.textContent;var tag=el.tagName?el.tagName.toLowerCase():'';if(['script','style','noscript','nav','footer','svg','iframe'].includes(tag))return'';var t='';for(var c of el.childNodes){t+=toMd(c,d+1);}t=t.trim();if(!t)return'';if(tag==='h1')return'\n# '+t+'\n';if(tag==='h2')return'\n## '+t+'\n';if(tag==='h3')return'\n### '+t+'\n';if(tag==='h4')return'\n#### '+t+'\n';if(tag==='p')return'\n'+t+'\n';if(tag==='li')return'- '+t+'\n';if(tag==='a'){var h=el.getAttribute('href')||'';if(h&&!h.startsWith('javascript:')&&!h.startsWith('#'))return'['+t+']('+h+')';return t;}if(tag==='strong'||tag==='b')return'**'+t+'**';if(tag==='em'||tag==='i')return'*'+t+'*';if(tag==='code')return'`'+t+'`';if(tag==='pre')return'\n```\n'+t+'\n```\n';return t+(tag==='div'||tag==='section'?'\n':' ');}var md=toMd(target,0);md=md.replace(/\n{3,}/g,'\n\n').trim();return md.substring(0,8000);})()"""


# ── DOM Snapshot JS (returns structured DOM info for code-first agent) ──
_DOM_SNAPSHOT_JS = r"""(function(){
var s={url:location.href,title:document.title,forms:[],buttons:[],links:[],inputs:[],headings:[],text:''};
function sel(el){if(el.id)return'#'+el.id;if(el.name)return el.tagName.toLowerCase()+'[name="'+el.name+'"]';if(el.className&&typeof el.className==='string'){var c=el.className.trim().split(/\s+/).slice(0,2).join('.');if(c)return el.tagName.toLowerCase()+'.'+c;}return el.tagName.toLowerCase();}
document.querySelectorAll('form').forEach(function(f){var fields=[];f.querySelectorAll('input,select,textarea').forEach(function(i){fields.push({tag:i.tagName,type:i.type||'',name:i.name||'',id:i.id||'',placeholder:i.placeholder||'',selector:sel(i)});});s.forms.push({action:f.action||'',method:f.method||'',fields:fields});});
document.querySelectorAll('input:not(form input),textarea:not(form textarea),select:not(form select),[contenteditable="true"]').forEach(function(i){var r=i.getBoundingClientRect();if(r.width>0&&r.height>0)s.inputs.push({tag:i.tagName,type:i.type||'',name:i.name||'',id:i.id||'',placeholder:i.placeholder||'',selector:sel(i)});});
var bc=0;document.querySelectorAll('button,[role="button"],input[type="submit"]').forEach(function(b){if(bc>=30)return;var r=b.getBoundingClientRect();if(r.width<=0||r.height<=0)return;s.buttons.push({text:b.textContent.trim().substring(0,80),selector:sel(b)});bc++;});
var lc=0;document.querySelectorAll('a[href]').forEach(function(a){if(lc>=30)return;var r=a.getBoundingClientRect();if(r.width<=0||r.height<=0)return;s.links.push({text:a.textContent.trim().substring(0,80),href:a.href,selector:sel(a)});lc++;});
document.querySelectorAll('h1,h2,h3').forEach(function(h){s.headings.push({level:h.tagName,text:h.textContent.trim().substring(0,120)});});
var main=document.querySelector('main,article,[role="main"],.content,#content')||document.body;s.text=main.innerText.substring(0,3000);
return JSON.stringify(s);})()"""


# ── JS for ref-based actions ──

_CLICK_BY_REF_JS = """(function() {
  var el = document.querySelector('[data-lobster-id="%d"]');
  if (!el) return JSON.stringify({ found: false, error: 'Element #%d not found in DOM' });
  var rect = el.getBoundingClientRect();
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.focus();
  el.click();
  return JSON.stringify({ found: true, tag: el.tagName, text: (el.textContent || '').trim().substring(0, 60) });
})()"""

_TYPE_INTO_REF_JS = """(function() {
  var el = document.querySelector('[data-lobster-id="%d"]');
  if (!el) return JSON.stringify({ found: false, error: 'Element #%d not found in DOM' });
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.focus();
  // Use native setter for React/Angular/Vue compatibility
  var tag = el.tagName;
  var isEditable = el.getAttribute('contenteditable') === 'true';
  if (isEditable) {
    // Rich text editors (LinkedIn, Gmail, Slack) need innerHTML + InputEvent
    el.focus();
    el.innerHTML = '<p>' + %s + '</p>';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: %s }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    // Also try execCommand for editors that listen to it
    try { document.execCommand('selectAll'); document.execCommand('insertText', false, %s); } catch(e) {}
  } else {
    var proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) {
      setter.set.call(el, %s);
    } else {
      el.value = %s;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Unidentified' }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
  }
  return JSON.stringify({ found: true, tag: tag, typed: el.value ? el.value.substring(0, 40) : el.textContent.substring(0, 40) });
})()"""

_WAIT_FOR_JS = {
    "page_load": """(function() {
        return JSON.stringify({ ready: document.readyState === 'complete', state: document.readyState });
    })()""",
    "network_idle": """(function() {
        // Check if any XHR/fetch is pending by monitoring performance entries
        var entries = performance.getEntriesByType('resource').filter(function(e) {
            return Date.now() - e.startTime < 2000 && e.duration === 0;
        });
        return JSON.stringify({ idle: entries.length === 0, pending: entries.length });
    })()""",
    "element_visible": """(function() {
        var el = document.querySelector('%s');
        if (!el) return JSON.stringify({ found: false });
        var rect = el.getBoundingClientRect();
        var visible = rect.width > 0 && rect.height > 0;
        return JSON.stringify({ found: true, visible: visible, text: (el.textContent || '').substring(0, 60) });
    })()""",
    "text_visible": """(function() {
        var text = document.body.innerText || '';
        var found = text.indexOf('%s') !== -1;
        return JSON.stringify({ found: found });
    })()""",
}

# ── Gather elements JS (same as index.ts GATHER_ELEMENTS_ONLY_JS) ──
_GATHER_ELEMENTS_JS = r"""(function() {
  window.__lobsterElementMap = [];
  var selectors = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [onclick], [tabindex]:not([tabindex="-1"]), img[alt], video, [contenteditable="true"], h3 a, [data-href], summary, [data-control-name], .artdeco-button, .msg-form__contenteditable, [contenteditable="true"], .entity-result__title-text a';
  var elements = document.querySelectorAll(selectors);
  var results = [];
  var id = 0;
  var seen = new Set();
  for (var i = 0; i < elements.length && id < 150; i++) {
    var el = elements[i];
    if (seen.has(el)) continue;
    seen.add(el);
    var rect = el.getBoundingClientRect();
    if (rect.width < 5 || rect.height < 5) continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
    if (rect.right < 0 || rect.left > window.innerWidth) continue;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.1) continue;
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute('role') || tag;
    var text = '';
    if (tag === 'a' || tag === 'button') {
      var childTexts = [];
      for (var c = 0; c < el.childNodes.length; c++) {
        var node = el.childNodes[c];
        if (node.nodeType === 3) childTexts.push(node.textContent.trim());
        else if (node.nodeType === 1 && ['SPAN','STRONG','EM','B','I','H3','CITE','DIV'].indexOf(node.tagName) !== -1) {
          childTexts.push((node.textContent || '').trim());
        }
      }
      text = childTexts.join(' ').replace(/\s+/g, ' ').trim();
      if (!text) text = (el.textContent || '').trim().replace(/\s+/g, ' ');
    } else {
      text = (el.textContent || '').trim().replace(/\s+/g, ' ');
    }
    text = text.substring(0, 100);
    var ariaLabel = el.getAttribute('aria-label') || '';
    var title = el.getAttribute('title') || '';
    var name = el.getAttribute('name') || '';
    var placeholder = el.getAttribute('placeholder') || '';
    var value = (el.value || '').substring(0, 30);
    var type = el.getAttribute('type') || '';
    var href = el.getAttribute('href') || el.getAttribute('data-href') || '';
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var x768 = Math.round((cx / window.innerWidth) * 768);
    var y768 = Math.round((cy / window.innerHeight) * 768);
    var label = ariaLabel || text || title || placeholder || value || name || (tag + (type ? '[' + type + ']' : ''));
    if (!label || label === tag || label === 'button') {
      var svgTitle = el.querySelector('svg title');
      if (svgTitle) label = (svgTitle.textContent || '').trim();
      if (!label || label === tag || label === 'button') {
        var par = el.closest('[aria-label]');
        if (par && par !== el) label = par.getAttribute('aria-label') || '';
      }
    }
    var section = '';
    var secEl = el.closest('[aria-label], [role="region"], [role="navigation"], nav[aria-label]');
    if (secEl && secEl !== el) section = secEl.getAttribute('aria-label') || '';
    results.push({
      id: id, tag: tag, role: role, type: type,
      label: label.substring(0, 100),
      title: title.substring(0, 60),
      name: name.substring(0, 40),
      section: section.substring(0, 60),
      href: href.substring(0, 120),
      x: x768, y: y768,
      cx: Math.round(cx), cy: Math.round(cy),
      w: Math.round(rect.width), h: Math.round(rect.height)
    });
    el.setAttribute('data-lobster-id', String(id));
    id++;
  }
  window.__lobsterElementMap = results;
  return JSON.stringify(results);
})()"""


# ── Image generation helper ──

_GALLERY_HTML = """<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Lobster Gallery</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Italiana&display=swap');
body{background:#030305;color:#fff;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;min-height:100vh;position:relative;overflow-x:hidden}

/* ── Aurora animated background ── */
.aurora{position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden}
.aurora-orb{position:absolute;border-radius:50%;filter:blur(80px);opacity:0;animation:orb-drift 20s ease-in-out infinite}
.aurora-orb:nth-child(1){width:600px;height:600px;background:radial-gradient(circle,rgba(183,13,17,0.15),transparent 70%);top:-10%;left:10%;animation-delay:0s;animation-duration:18s}
.aurora-orb:nth-child(2){width:500px;height:500px;background:radial-gradient(circle,rgba(255,43,68,0.1),transparent 70%);top:30%;right:-5%;animation-delay:-6s;animation-duration:22s}
.aurora-orb:nth-child(3){width:700px;height:700px;background:radial-gradient(circle,rgba(120,0,60,0.08),transparent 70%);bottom:-15%;left:30%;animation-delay:-12s;animation-duration:25s}
.aurora-orb:nth-child(4){width:400px;height:400px;background:radial-gradient(circle,rgba(255,80,100,0.06),transparent 70%);top:60%;left:-10%;animation-delay:-4s;animation-duration:20s}
@keyframes orb-drift{0%{opacity:0.4;transform:translate(0,0) scale(1)}25%{opacity:0.8;transform:translate(40px,-30px) scale(1.1)}50%{opacity:0.5;transform:translate(-20px,50px) scale(0.95)}75%{opacity:0.9;transform:translate(30px,20px) scale(1.05)}100%{opacity:0.4;transform:translate(0,0) scale(1)}}

/* ── SVG grain overlay ── */
body::after{content:'';position:fixed;inset:0;opacity:0.025;pointer-events:none;z-index:1;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}

/* ── Header ── */
.header{position:sticky;top:0;z-index:10;padding:24px 40px;display:flex;align-items:center;gap:16px;border-bottom:1px solid rgba(255,255,255,0.04);backdrop-filter:blur(24px) saturate(1.4);-webkit-backdrop-filter:blur(24px) saturate(1.4);background:rgba(6,6,10,0.6)}
.header-logo{display:flex;align-items:center;gap:12px}
.header-logo svg{width:28px;height:28px;filter:drop-shadow(0 0 8px rgba(255,43,68,0.3))}
.header h1{font-family:'Italiana',serif;font-size:24px;font-weight:400;background:linear-gradient(135deg,#FF2B44 0%,#ff8090 40%,#FF2B44 80%,#B70D11 100%);background-size:200% 200%;-webkit-background-clip:text;-webkit-text-fill-color:transparent;animation:gradient-shift 6s ease-in-out infinite;letter-spacing:0.02em}
@keyframes gradient-shift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
.header .subtitle{color:rgba(255,255,255,0.2);font-size:11px;font-weight:400;letter-spacing:0.06em;text-transform:uppercase;margin-left:4px}
.header .count{color:rgba(255,255,255,0.3);font-size:11px;padding:4px 12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:20px;font-weight:500;margin-left:auto;backdrop-filter:blur(8px);letter-spacing:0.02em;transition:all 0.3s ease}
.header .count:hover{background:rgba(255,43,68,0.08);border-color:rgba(255,43,68,0.15);color:rgba(255,255,255,0.5)}

/* ── Grid ── */
.grid{position:relative;z-index:2;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:24px;padding:32px 40px}

/* ── Cards ── */
.card{background:rgba(255,255,255,0.02);backdrop-filter:blur(16px) saturate(1.2);-webkit-backdrop-filter:blur(16px) saturate(1.2);border:1px solid rgba(255,255,255,0.05);border-radius:16px;overflow:hidden;transition:all 0.4s cubic-bezier(0.16,1,0.3,1);cursor:pointer;opacity:0;animation:card-enter 0.7s cubic-bezier(0.16,1,0.3,1) forwards}
.card:hover{transform:translateY(-6px) scale(1.01);box-shadow:0 20px 60px rgba(183,13,17,0.2),0 0 0 1px rgba(255,43,68,0.12),0 0 80px rgba(255,43,68,0.05);border-color:rgba(255,43,68,0.2)}
.card:active{transform:translateY(-2px) scale(0.99)}
.card .img-wrap{position:relative;overflow:hidden;aspect-ratio:1;background:rgba(12,12,16,0.8)}
.card .img-wrap img{width:100%;height:100%;object-fit:cover;display:block;transition:transform 0.6s cubic-bezier(0.16,1,0.3,1)}
.card:hover .img-wrap img{transform:scale(1.05)}
.card .img-wrap .overlay{position:absolute;inset:0;background:linear-gradient(180deg,transparent 50%,rgba(0,0,0,0.6) 100%);opacity:0;transition:opacity 0.3s ease;display:flex;align-items:flex-end;justify-content:center;padding:16px}
.card:hover .img-wrap .overlay{opacity:1}
.card .img-wrap .overlay .dl-btn{padding:6px 16px;background:rgba(255,255,255,0.15);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.2);border-radius:20px;color:#fff;font-size:11px;font-weight:500;letter-spacing:0.04em;cursor:pointer;transition:all 0.2s ease;display:flex;align-items:center;gap:6px}
.card .img-wrap .overlay .dl-btn:hover{background:rgba(255,43,68,0.3);border-color:rgba(255,43,68,0.4)}
.card .info{padding:14px 16px;background:linear-gradient(180deg,rgba(8,8,12,0.3) 0%,rgba(8,8,12,0.5) 100%)}
.card .prompt{color:rgba(255,255,255,0.45);font-size:11.5px;line-height:1.55;max-height:54px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;font-weight:400}
.card .meta{display:flex;align-items:center;justify-content:space-between;margin-top:8px}
.card .time{color:rgba(255,255,255,0.15);font-size:10px;font-weight:500;letter-spacing:0.03em}
.card .badge{color:rgba(255,43,68,0.5);font-size:9px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;padding:2px 8px;background:rgba(255,43,68,0.06);border-radius:8px}
@keyframes card-enter{from{opacity:0;transform:translateY(20px) scale(0.95)}to{opacity:1;transform:translateY(0) scale(1)}}

/* ── Generating placeholder ── */
.generating .gen-inner{aspect-ratio:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:linear-gradient(135deg,rgba(12,12,16,0.95),rgba(20,14,18,0.9));position:relative;overflow:hidden}
.generating .gen-inner::before{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent 0%,rgba(255,43,68,0.05) 50%,transparent 100%);animation:gen-shimmer 2.5s ease-in-out infinite}
.generating .gen-inner::after{content:'';position:absolute;inset:0;background:radial-gradient(circle at 50% 50%,rgba(255,43,68,0.04),transparent 60%);animation:gen-pulse 3s ease-in-out infinite}
.gen-spinner{width:32px;height:32px;border:2px solid rgba(255,255,255,0.06);border-top-color:rgba(255,43,68,0.5);border-radius:50%;animation:spin 1s linear infinite;z-index:1}
.gen-text{color:rgba(255,255,255,0.2);font-size:11px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;z-index:1}
@keyframes gen-shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
@keyframes gen-pulse{0%,100%{opacity:0.5}50%{opacity:1}}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── Empty state ── */
.empty{text-align:center;padding:120px 32px;grid-column:1/-1}
.empty-icon{width:64px;height:64px;margin:0 auto 20px;opacity:0.08}
.empty-title{color:rgba(255,255,255,0.15);font-size:16px;font-weight:500;margin-bottom:8px;letter-spacing:-0.01em}
.empty-sub{color:rgba(255,255,255,0.08);font-size:12px;font-weight:400;letter-spacing:0.02em}

/* ── Lightbox ── */
.lightbox{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,0.85);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);display:none;align-items:center;justify-content:center;opacity:0;transition:opacity 0.3s ease;cursor:zoom-out}
.lightbox.active{display:flex;opacity:1}
.lightbox img{max-width:85vw;max-height:85vh;border-radius:12px;box-shadow:0 16px 80px rgba(0,0,0,0.5);transition:transform 0.4s cubic-bezier(0.16,1,0.3,1)}
.lightbox .close{position:absolute;top:24px;right:24px;width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:center;cursor:pointer;color:rgba(255,255,255,0.5);font-size:18px;transition:all 0.2s ease;backdrop-filter:blur(12px)}
.lightbox .close:hover{background:rgba(255,43,68,0.2);border-color:rgba(255,43,68,0.3);color:#fff}

/* ── Scrollbar ── */
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.06);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.12)}
</style></head><body>

<!-- Aurora orbs -->
<div class="aurora">
  <div class="aurora-orb"></div>
  <div class="aurora-orb"></div>
  <div class="aurora-orb"></div>
  <div class="aurora-orb"></div>
</div>

<!-- Header -->
<div class="header">
  <div class="header-logo">
    <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="52" r="28" fill="#B70D11" opacity="0.9"/>
      <ellipse cx="50" cy="50" rx="26" ry="24" fill="#FF2B44"/>
      <circle cx="40" cy="46" r="4" fill="#fff"/><circle cx="60" cy="46" r="4" fill="#fff"/>
      <circle cx="41" cy="46" r="2" fill="#1a1a2e"/><circle cx="61" cy="46" r="2" fill="#1a1a2e"/>
      <path d="M38 58 Q50 66 62 58" stroke="#fff" stroke-width="2.5" stroke-linecap="round" fill="none"/>
      <path d="M30 30 Q26 18 20 22" stroke="#FF2B44" stroke-width="3" stroke-linecap="round" fill="none"/>
      <path d="M70 30 Q74 18 80 22" stroke="#FF2B44" stroke-width="3" stroke-linecap="round" fill="none"/>
      <path d="M24 56 L10 62 L12 58 L8 54" stroke="#FF2B44" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <path d="M76 56 L90 62 L88 58 L92 54" stroke="#FF2B44" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </svg>
    <div>
      <h1>Gallery</h1>
      <span class="subtitle">AI-Generated Creations</span>
    </div>
  </div>
  <span class="count" id="count">0 images</span>
</div>

<!-- Grid -->
<div class="grid" id="grid">
  <div class="empty" id="empty">
    <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
    <div class="empty-title">No images yet</div>
    <div class="empty-sub">Ask Lobster to generate or create images — they'll appear here</div>
  </div>
</div>

<!-- Lightbox -->
<div class="lightbox" id="lightbox" onclick="this.classList.remove('active')">
  <img id="lb-img" src="" alt="">
  <div class="close" onclick="event.stopPropagation();document.getElementById('lightbox').classList.remove('active')">&times;</div>
</div>

<script>
window._images = [];
var _cardIndex = 0;
window.addImage = function(data) {
  window._images.push(data);
  document.getElementById('empty')?.remove();
  var grid = document.getElementById('grid');
  var card = document.createElement('div');
  card.className = 'card';
  card.style.animationDelay = '0.05s';
  var idx = window._images.length;
  var promptText = (data.prompt || '').replace(/</g,'&lt;').substring(0,140);
  var timeStr = new Date(data.ts || Date.now()).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  card.innerHTML = '<div class="img-wrap"><img src="' + data.src + '" alt="Generated">' +
    '<div class="overlay"><div class="dl-btn" onclick="event.stopPropagation();downloadImg(' + (idx-1) + ')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Save</div></div>' +
    '</div><div class="info"><div class="prompt">' + promptText +
    '</div><div class="meta"><span class="time">' + timeStr + '</span><span class="badge">AI Generated</span></div></div>';
  card.onclick = function() { openLightbox(data.src); };
  grid.insertBefore(card, grid.firstChild);
  document.getElementById('count').textContent = window._images.length + ' image' + (window._images.length !== 1 ? 's' : '');
};
window.showGenerating = function() {
  var grid = document.getElementById('grid');
  document.getElementById('empty')?.remove();
  var ph = document.createElement('div');
  ph.className = 'card generating';
  ph.id = 'generating-placeholder';
  ph.style.opacity = '1';
  ph.innerHTML = '<div class="gen-inner"><div class="gen-spinner"></div><div class="gen-text">Creating...</div></div>';
  grid.insertBefore(ph, grid.firstChild);
};
window.hideGenerating = function() {
  var ph = document.getElementById('generating-placeholder');
  if (ph) ph.remove();
};
function openLightbox(src) {
  var lb = document.getElementById('lightbox');
  document.getElementById('lb-img').src = src;
  lb.classList.add('active');
}
function downloadImg(idx) {
  var img = window._images[idx];
  if (!img) return;
  var a = document.createElement('a');
  a.href = img.src;
  a.download = 'lobster-' + Date.now() + '.png';
  a.click();
}
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') document.getElementById('lightbox').classList.remove('active');
});
</script>
</body></html>"""

_gallery_tab_ids: dict[str, str] = {}  # session_id → taskId of gallery tab

async def _generate_image(prompt: str) -> str | None:
    """Generate image via Gemini Imagen, return base64 data URI or None on failure."""
    try:
        response = await genai_client.aio.models.generate_content(
            model=IMAGE_GEN_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_modalities=["TEXT", "IMAGE"],
            ),
        )
        for part in (response.candidates[0].content.parts if response.candidates else []):
            if hasattr(part, 'inline_data') and part.inline_data and part.inline_data.data:
                mime = part.inline_data.mime_type or "image/png"
                b64 = base64.b64encode(part.inline_data.data).decode("utf-8")
                return f"data:{mime};base64,{b64}"
        print(f"[image-gen] No image in response for: {prompt[:60]}")
        return None
    except Exception as e:
        print(f"[image-gen] Error: {e}")
        return None

_INJECT_IMAGE_OVERLAY_JS = """(function() {
  var old = document.getElementById('lobster-image-overlay');
  if (old) old.remove();
  var wrap = document.createElement('div');
  wrap.id = 'lobster-image-overlay';
  wrap.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';
  var img = document.createElement('img');
  img.src = '{{IMAGE_DATA}}';
  img.style.cssText = 'max-width:80vw;max-height:80vh;border-radius:12px;box-shadow:0 8px 60px rgba(0,0,0,0.6);';
  var closeBtn = document.createElement('div');
  closeBtn.textContent = '\u2715';
  closeBtn.style.cssText = 'position:absolute;top:20px;right:20px;color:white;font-size:32px;cursor:pointer;width:44px;height:44px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(255,255,255,0.15);transition:background 0.2s;';
  closeBtn.onmouseenter = function() { closeBtn.style.background = 'rgba(255,255,255,0.3)'; };
  closeBtn.onmouseleave = function() { closeBtn.style.background = 'rgba(255,255,255,0.15)'; };
  closeBtn.onclick = function() { wrap.remove(); };
  wrap.onclick = function(e) { if (e.target === wrap) wrap.remove(); };
  document.addEventListener('keydown', function _esc(e) { if (e.key === 'Escape') { wrap.remove(); document.removeEventListener('keydown', _esc); } });
  setTimeout(function() { if (wrap.parentNode) wrap.remove(); }, 30000);
  wrap.appendChild(img);
  wrap.appendChild(closeBtn);
  document.body.appendChild(wrap);
  return 'Image overlay with close button injected';
})()"""

_INJECT_IMAGE_EXCALIDRAW_JS = """(function() {
  // Try Excalidraw API first
  var api = window.collab && window.collab.excalidrawAPI;
  if (!api) {
    // Fallback: find Excalidraw instance
    var el = document.querySelector('.excalidraw');
    if (el && el.__excalidraw) api = el.__excalidraw;
  }
  if (api && api.addFiles && api.updateScene) {
    var fileId = 'lobster_gen_' + Date.now();
    api.addFiles([{ id: fileId, dataURL: '{{IMAGE_DATA}}', mimeType: 'image/png', created: Date.now() }]);
    var scene = api.getSceneElements ? api.getSceneElements() : [];
    var newEl = {
      type: 'image', fileId: fileId,
      x: 200, y: 200, width: 400, height: 400,
      id: 'lobster_img_' + Date.now(),
      strokeColor: 'transparent', backgroundColor: 'transparent',
      fillStyle: 'solid', strokeWidth: 0, roughness: 0, opacity: 100,
      roundness: null, seed: Math.floor(Math.random() * 2000000000),
      version: 1, versionNonce: Math.floor(Math.random() * 2000000000),
      isDeleted: false, groupIds: [], boundElements: null, link: null, locked: false,
      status: 'saved', scale: [1, 1],
    };
    api.updateScene({ elements: [...scene, newEl] });
    return 'Image injected into Excalidraw canvas via API';
  }
  // Fallback: just overlay
  var img = document.createElement('img');
  img.src = '{{IMAGE_DATA}}';
  img.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);max-width:70vw;max-height:70vh;z-index:99999;border-radius:12px;box-shadow:0 8px 60px rgba(0,0,0,0.6);';
  document.body.appendChild(img);
  return 'Image injected as overlay (Excalidraw API not found)';
})()"""


# ── Hive Memory tool functions (used by executors and cron) ──

def _hive_write(session_id: str, key: str, value: str, source_task: str = "unknown"):
    """Store a value in Hive Memory for cross-agent sharing."""
    _HIVE_MEMORY.setdefault(session_id, {})[key] = {
        "value": value[:2000],  # Cap at 2KB per entry
        "source": source_task,
        "ts": time.time(),
    }
    print(f"[hive] WRITE [{session_id}] {key} = {value[:80]}... (from {source_task})")

def _hive_read(session_id: str, key: str = "*") -> dict:
    """Read from Hive Memory. key='*' returns all entries."""
    mem = _HIVE_MEMORY.get(session_id, {})
    if key == "*":
        return {k: v["value"] for k, v in mem.items()}
    entry = mem.get(key)
    return {"value": entry["value"], "source": entry["source"]} if entry else {"value": None}

def _hive_snapshot_for_prompt(session_id: str, max_entries: int = 10) -> str:
    """Format Hive Memory as text for injection into executor prompts."""
    mem = _HIVE_MEMORY.get(session_id, {})
    if not mem:
        return ""
    # Show most recent entries
    sorted_entries = sorted(mem.items(), key=lambda x: x[1].get("ts", 0), reverse=True)[:max_entries]
    lines = [f"  - {k}: {v['value'][:150]}" for k, v in sorted_entries]
    return "\n[HIVE MEMORY — shared knowledge from other agents]:\n" + "\n".join(lines) + "\n"


# ── Self-healing DOM: auto-clear popups/modals/cookie banners ──
_CLEAR_BLOCKERS_JS = """(function(){
  var selectors = [
    '[role="dialog"]', '[aria-modal="true"]',
    '.cookie-banner', '#cookie-consent', '.popup-overlay',
    '[class*="cookie"]', '[class*="consent"]', '[class*="modal-overlay"]',
    '[id*="cookie"]', '[id*="popup"]', '[id*="banner"]',
    '[class*="overlay"][class*="cookie"]', '[class*="gdpr"]',
    '.cc-banner', '#onetrust-banner-sdk', '.fc-consent-root'
  ];
  var removed = 0;
  selectors.forEach(function(s) {
    try {
      document.querySelectorAll(s).forEach(function(el) {
        var z = parseInt(getComputedStyle(el).zIndex) || 0;
        if (el.offsetHeight > 80 || z > 100) {
          el.remove(); removed++;
        }
      });
    } catch(e) {}
  });
  document.body.style.overflow = 'auto';
  return removed + ' blockers removed';
})()"""

# ── Tool executor (maps tool names to Electron actions) ──

async def _execute_tool(session_id: str, name: str, args: dict, task_id: str | None = None) -> dict:
    """Execute a hybrid browser tool — JS for DOM, native events for physical interactions.
    Every path is wrapped in try/except so a single bad tool never crashes the executor."""
    a = args or {}
    timeout = 15.0

    try:
        return await _execute_tool_inner(session_id, name, a, task_id, timeout)
    except Exception as e:
        print(f"[executor] _execute_tool CRASH ({name}): {e}")
        return {"status": "execution_failed", "error": str(e)[:300], "hint": "Tool execution failed. Try a different tool or fix your arguments."}


async def _execute_tool_inner(session_id: str, name: str, a: dict, task_id: str | None, timeout: float) -> dict:
    """Inner tool executor — called by _execute_tool with error boundary."""
    if name == "execute_js":
        return await _send_action_direct(session_id, {"action": "evaluate", "code": a.get("code", "")}, task_id=task_id, timeout=timeout)

    elif name == "navigate":
        url = a.get("url", "")
        if url and not url.startswith("http"):
            url = f"https://{url}"
        return await _send_action_direct(session_id, {"action": "navigate", "url": url}, task_id=task_id, timeout=timeout)

    elif name == "click":
        return await _send_action_direct(session_id, {"action": "click", "x": a.get("x", 0), "y": a.get("y", 0)}, task_id=task_id, timeout=timeout)

    elif name == "type_text":
        return await _send_action_direct(session_id, {"action": "type", "text": a.get("text", "")}, task_id=task_id, timeout=timeout)

    elif name == "press_key":
        return await _send_action_direct(session_id, {"action": "press-key", "key": a.get("key", "Enter")}, task_id=task_id, timeout=timeout)

    elif name == "scroll":
        return await _send_action_direct(session_id, {"action": "scroll", "direction": a.get("direction", "down")}, task_id=task_id, timeout=timeout)

    elif name == "drag":
        return await _send_action_direct(session_id, {
            "action": "drag",
            "from_x": a.get("from_x", 0), "from_y": a.get("from_y", 0),
            "to_x": a.get("to_x", 0), "to_y": a.get("to_y", 0),
            "description": a.get("description", "drag"),
        }, task_id=task_id, timeout=timeout)

    elif name == "draw_path":
        return await _send_action_direct(session_id, {
            "action": "drag-path",
            "points": a.get("points", []),
            "description": a.get("description", "draw"),
        }, task_id=task_id, timeout=timeout)

    elif name == "click_by_ref":
        ref = int(a.get("ref", 0))
        js_code = _CLICK_BY_REF_JS % (ref, ref)
        result = await _send_action_direct(session_id, {"action": "evaluate", "code": js_code}, task_id=task_id, timeout=timeout)
        # Parse result — detect stale/missing refs so LLM can self-heal
        try:
            raw = result.get("result", "{}")
            data = json.loads(raw) if isinstance(raw, str) else raw
            if isinstance(data, dict) and not data.get("found", True):
                return {"status": "error", "message": f"Element ref #{ref} is STALE or missing. The page likely re-rendered. Look at the fresh [PAGE ELEMENTS] map below and find the correct new reference ID."}
        except Exception:
            pass
        return result

    elif name == "type_into_ref":
        ref = int(a.get("ref", 0))
        text = a.get("text", "")
        # Escape text for JS string literal
        escaped = json.dumps(text)  # produces "text" with proper escaping
        js_code = _TYPE_INTO_REF_JS % (ref, ref, escaped, escaped, escaped, escaped, escaped)
        result = await _send_action_direct(session_id, {"action": "evaluate", "code": js_code}, task_id=task_id, timeout=timeout)
        # Parse result — detect stale/missing refs so LLM can self-heal
        try:
            raw = result.get("result", "{}")
            data = json.loads(raw) if isinstance(raw, str) else raw
            if isinstance(data, dict) and not data.get("found", True):
                return {"status": "error", "message": f"Element ref #{ref} is STALE or missing. The page likely re-rendered. Look at the fresh [PAGE ELEMENTS] map below and find the correct new reference ID."}
        except Exception:
            pass
        return result

    elif name == "wait_for":
        condition = a.get("condition", "page_load")
        target = a.get("target", "")
        max_wait = min(int(a.get("timeout", 5)), 15)
        # Poll until condition met or timeout
        for _poll in range(max_wait * 4):  # Check 4x per second
            if condition == "element_visible" and target:
                js = _WAIT_FOR_JS["element_visible"] % target.replace("'", "\\'")
            elif condition == "text_visible" and target:
                js = _WAIT_FOR_JS["text_visible"] % target.replace("'", "\\'")
            elif condition == "network_idle":
                js = _WAIT_FOR_JS["network_idle"]
            else:
                js = _WAIT_FOR_JS["page_load"]
            result = await _send_action_direct(session_id, {"action": "evaluate", "code": js}, task_id=task_id, timeout=3.0)
            try:
                raw = result.get("result", "{}")
                data = json.loads(raw) if isinstance(raw, str) else raw
                if not isinstance(data, dict):
                    data = {}  # json.loads("true") → bool, not dict
                if condition == "page_load" and data.get("ready"):
                    return {"status": "ok", "message": "Page fully loaded"}
                elif condition == "network_idle" and data.get("idle"):
                    return {"status": "ok", "message": "Network idle"}
                elif condition == "element_visible" and data.get("found") and data.get("visible"):
                    return {"status": "ok", "message": f"Element found: {data.get('text', '')}"}
                elif condition == "text_visible" and data.get("found"):
                    return {"status": "ok", "message": f"Text '{target[:30]}' found on page"}
            except (json.JSONDecodeError, TypeError, AttributeError):
                pass
            await asyncio.sleep(0.25)
        return {"status": "timeout", "message": f"Condition '{condition}' not met after {max_wait}s"}

    elif name == "generate_image":
        # Dedup: prevent duplicate image generation within same task
        if _task_image_generated.get(task_id):
            return {"status": "skipped", "message": "Image already generated this task. Verify result in screenshot and call done() to finish."}
        prompt = a.get("prompt", "")
        inject_mode = a.get("inject_mode", "overlay")
        # Lobster identity: selfie/autoportret → generate Lobster character
        selfie_keywords = ["selfie", "self-portrait", "autoportret", "your photo", "your picture",
                           "twoje zdjecie", "twoja fotka", "zdjecie siebie", "twoj portret", "your face"]
        if any(kw in prompt.lower() for kw in selfie_keywords):
            prompt = f"A cute, charismatic red lobster character (mascot named 'Lobster') taking a selfie. The lobster has big expressive eyes, a friendly smile, and is styled with modern tech/browser aesthetics, wearing tiny headphones. Vibrant, playful, high quality digital art. {prompt}"
        print(f"[image-gen] Generating: '{prompt[:80]}' mode={inject_mode}")
        # Open/show Gallery tab with "generating..." placeholder
        ws_gallery = _websockets.get(session_id)
        if ws_gallery and inject_mode != "excalidraw":
            try:
                await ws_gallery.send_json({"type": "open_gallery_tab", "session_id": session_id})
                await asyncio.sleep(0.5)  # Wait for tab creation
                # Show generating placeholder
                await _send_action_direct(session_id, {"action": "evaluate_gallery", "code": "window.showGenerating && window.showGenerating()"}, task_id=task_id, timeout=3.0)
            except Exception as e:
                print(f"[image-gen] Gallery tab open error: {e}")

        data_uri = await _generate_image(prompt)
        _task_image_generated[task_id] = True  # Mark as generated
        if not data_uri:
            # Remove generating placeholder
            if ws_gallery and inject_mode != "excalidraw":
                try:
                    await _send_action_direct(session_id, {"action": "evaluate_gallery", "code": "window.hideGenerating && window.hideGenerating()"}, task_id=task_id, timeout=3.0)
                except Exception:
                    pass
            return {"status": "error", "message": "Image generation failed — try with a different prompt"}

        # Inject into appropriate target
        if inject_mode == "excalidraw":
            js = _INJECT_IMAGE_EXCALIDRAW_JS.replace("{{IMAGE_DATA}}", data_uri)
            result = await _send_action_direct(session_id, {"action": "evaluate", "code": js}, task_id=task_id, timeout=15.0)
        else:
            # Add to Gallery tab
            safe_prompt = prompt.replace("'", "\\'").replace('"', '\\"').replace('\n', ' ')[:120]
            gallery_js = f"window.hideGenerating && window.hideGenerating(); window.addImage && window.addImage({{src: '{data_uri[:100]}...truncated', prompt: '{safe_prompt}', ts: {int(time.time() * 1000)}}})"
            # Actually inject the full data URI — use a different approach to avoid string size issues
            gallery_inject = f"""(function(){{
  window.hideGenerating && window.hideGenerating();
  window.addImage && window.addImage({{
    src: "{data_uri}",
    prompt: "{safe_prompt}",
    ts: {int(time.time() * 1000)}
  }});
  return 'Image added to gallery';
}})()"""
            try:
                await _send_action_direct(session_id, {"action": "evaluate_gallery", "code": gallery_inject}, task_id=task_id, timeout=15.0)
            except Exception as e:
                print(f"[image-gen] Gallery inject error: {e}")
            # Also show overlay on current page
            js = _INJECT_IMAGE_OVERLAY_JS.replace("{{IMAGE_DATA}}", data_uri)
            result = await _send_action_direct(session_id, {"action": "evaluate", "code": js}, task_id=task_id, timeout=15.0)

        print(f"[image-gen] Inject result: {result}")
        return {"status": "ok", "message": f"Image generated and added to Lobster Gallery ({inject_mode})", "result": result.get("result", "")}

    elif name == "done":
        return {"status": "done", "summary": a.get("summary", "Task complete.")}

    return {"status": "error", "message": f"Unknown tool: {name}"}


# ── Start/cancel executor tasks ──

def _start_executor(session_id: str, task: str, category: str, target_url: str | None = None) -> str:
    """Start a background executor task with its own task_id and result queue."""
    task_id = f"task_{_uuid.uuid4().hex[:8]}"
    _task_result_queues[task_id] = asyncio.Queue()
    _executor_active.setdefault(session_id, set()).add(task_id)
    _executor_tasks.setdefault(session_id, {})
    t = asyncio.create_task(_run_executor(session_id, task, category, task_id, target_url=target_url))
    _executor_tasks[session_id][task_id] = t
    return task_id


# ── Computer Use action mapper ──

def _tool_label_cu(name: str, args: dict) -> str:
    """Human-readable label for Computer Use actions."""
    labels = {
        "click_at": lambda a: f"Clicking ({a.get('x')}, {a.get('y')})",
        "type_text_at": lambda a: f"Typing: {str(a.get('text', ''))[:30]}",
        "scroll_document": lambda a: f"Scrolling {a.get('direction', 'down')}",
        "scroll_at": lambda a: f"Scrolling {a.get('direction', 'down')}",
        "navigate": lambda a: f"Opening {str(a.get('url', ''))[:40]}",
        "go_back": lambda a: "Going back",
        "go_forward": lambda a: "Going forward",
        "key_combination": lambda a: f"Pressing {a.get('keys', '')}",
        "hover_at": lambda a: "Hovering",
        "drag_and_drop": lambda a: "Dragging",
        "wait_5_seconds": lambda a: "Waiting...",
        "search": lambda a: "Opening search",
    }
    fn = labels.get(name)
    if fn:
        try:
            return fn(args)
        except Exception:
            return name
    return name


async def _execute_cu_action(session_id: str, name: str, args: dict, task_id: str):
    """Map Computer Use predefined actions to Electron IPC actions.
    CU uses 0-999 grid. Our screenshots are 768x768. Scale: cu_coord / 1000 * 768."""
    def cu_to_768(coord) -> int:
        return int(int(coord) * 768 / 1000)

    if name == "click_at":
        x, y = cu_to_768(args.get("x", 0)), cu_to_768(args.get("y", 0))
        await _send_action_direct(session_id, {"action": "click", "x": x, "y": y}, task_id=task_id)

    elif name == "type_text_at":
        x, y = cu_to_768(args.get("x", 0)), cu_to_768(args.get("y", 0))
        await _send_action_direct(session_id, {"action": "click", "x": x, "y": y}, task_id=task_id)
        await asyncio.sleep(0.3)
        if args.get("clear_before_typing", False):
            await _send_action_direct(session_id, {"action": "press-key", "key": "a", "ctrl": True}, task_id=task_id)
            await asyncio.sleep(0.1)
        text = args.get("text", "")
        if text:
            await _send_action_direct(session_id, {"action": "type", "text": text}, task_id=task_id)
        if args.get("press_enter", False):
            await asyncio.sleep(0.2)
            await _send_action_direct(session_id, {"action": "enter"}, task_id=task_id)

    elif name == "scroll_document":
        direction = args.get("direction", "down")
        await _send_action_direct(session_id, {"action": "scroll", "direction": direction, "amount": 400}, task_id=task_id)

    elif name == "scroll_at":
        direction = args.get("direction", "down")
        await _send_action_direct(session_id, {"action": "scroll", "direction": direction, "amount": int(args.get("magnitude", 400))}, task_id=task_id)

    elif name == "navigate":
        url = args.get("url", "")
        if url and not url.startswith("http"):
            url = f"https://{url}"
        await _send_action_direct(session_id, {"action": "navigate", "url": url}, task_id=task_id)

    elif name == "go_back":
        await _send_action_direct(session_id, {"action": "back"}, task_id=task_id)

    elif name == "go_forward":
        await _send_action_direct(session_id, {"action": "forward"}, task_id=task_id)

    elif name == "key_combination":
        keys = args.get("keys", "")
        parts = keys.split("+")
        key = parts[-1].lower() if parts else ""
        ctrl = any(p.lower() in ("control", "ctrl") for p in parts[:-1])
        shift = any(p.lower() == "shift" for p in parts[:-1])
        alt = any(p.lower() == "alt" for p in parts[:-1])
        await _send_action_direct(session_id, {"action": "press-key", "key": key, "ctrl": ctrl, "shift": shift, "alt": alt}, task_id=task_id)

    elif name == "hover_at":
        x, y = cu_to_768(args.get("x", 0)), cu_to_768(args.get("y", 0))
        await _send_action_direct(session_id, {"action": "hover", "x": x, "y": y}, task_id=task_id)

    elif name == "drag_and_drop":
        from_x = cu_to_768(args.get("x", 0))
        from_y = cu_to_768(args.get("y", 0))
        to_x = cu_to_768(args.get("destination_x", 0))
        to_y = cu_to_768(args.get("destination_y", 0))
        await _send_action_direct(session_id, {"action": "drag", "from_x": from_x, "from_y": from_y, "to_x": to_x, "to_y": to_y}, task_id=task_id)

    elif name == "wait_5_seconds":
        await asyncio.sleep(5)

    elif name == "search":
        await _send_action_direct(session_id, {"action": "navigate", "url": "https://www.google.com"}, task_id=task_id)


async def _run_executor(session_id: str, task: str, category: str, task_id: str = "default", target_url: str | None = None):
    """Hybrid executor: uses HYBRID_TOOLS (execute_js + native actions) — agent writes JS AND uses mouse/keyboard."""
    global _api_calls_total
    print(f"[executor] START {category} [{task_id}]: {task}")
    ws = _websockets.get(session_id)

    try:
        # Notify frontend
        if ws:
            try:
                await ws.send_json({"type": "task_progress", "status": "running", "task": task[:100], "task_id": task_id})
            except Exception:
                pass

        # Pre-navigate if URL known from router
        if target_url:
            result = await _send_action_direct(session_id, {"action": "navigate", "url": target_url}, task_id=task_id, timeout=15.0)
            print(f"[executor] Pre-navigate to {target_url[:60]}: {result.get('status', '?')}")
            # Wait longer for page to fully load (images, JS frameworks, etc.)
            await asyncio.sleep(2.5)

        # Poll for fresh screenshot — wait up to 5s for Electron to send one
        # REQUEST a fresh per-task screenshot from Electron
        ws = _websockets.get(session_id)
        if ws:
            try:
                await ws.send_json({"type": "request_screenshot", "task_id": task_id})
            except Exception:
                pass
        screenshot = None
        for _poll in range(10):
            screenshot = _task_screenshots.get(task_id)  # ONLY per-task, never session fallback
            if screenshot and len(screenshot) > 1000:
                break
            await asyncio.sleep(0.5)
        if not screenshot or len(screenshot) < 1000:
            # Last resort: try session-level only if per-task completely missing
            screenshot = _screenshots.get(session_id)
            if screenshot and len(screenshot) > 1000:
                print(f"[executor] WARNING: Using session-level screenshot (per-task unavailable)")
            else:
                print(f"[executor] WARNING: No fresh screenshot after 5s polling, proceeding anyway")

        elements = _task_element_maps.get(task_id) or _element_maps.get(session_id, [])
        elem_text = _format_element_map_for_model(elements) if elements else "(no page elements yet)"

        MAX_STEPS = 30 if category == "figma" else 20  # Figma designs need more steps
        result_text = "Task completed."
        last_calls_history: list[list[tuple]] = []  # Loop detection — last N call sets

        # Build category-specific hints
        category_hints = ""
        if category == "creative":
            category_hints = """
- This is a CREATIVE task — make it IMPRESSIVE.
- For GENERATING pictures (generate, create image, stwórz obraz):
  → Use generate_image(prompt="detailed description", inject_mode="overlay")
  → This creates PRO-QUALITY AI art and opens it in Gallery tab
  → Write a DETAILED prompt: style, colors, composition, mood, subject details
- For DRAWING (narysuj, namaluj, draw, paint, sketch):
  → Use draw_path/drag with physical mouse on canvas — ACTUAL cursor drawing
- For SIMPLE SHAPES/FLOWCHARTS on Excalidraw:
  → click canvas → press_key("7") for freedraw → VERIFY tool selected → draw_path
- AIM FOR WOW: The human is watching. Make it professional and impressive."""
        elif category == "research":
            category_hints = "\n- This is a RESEARCH task. Navigate to Google, scrape results via JS, open top results, extract content, synthesize."
        elif category == "figma":
            category_hints = """
- This is a FIGMA DESIGN task — you are building a UI design in Figma's web editor.
- You have 30 steps max. Work efficiently and produce a STUNNING, professional design.

FIGMA WORKFLOW:
1. If not already on Figma, navigate to figma.com. Log in if needed.
2. Create a new design file: click "+ New" or "New design file" button.
3. Use keyboard shortcuts to select tools, then click/drag on canvas to create elements.

FIGMA KEYBOARD SHORTCUTS (CRITICAL — memorize these):
  F = Frame tool (create containers/artboards — click and drag)
  R = Rectangle tool (click and drag to draw)
  O = Ellipse/Circle tool (click and drag)
  L = Line tool (click and drag)
  T = Text tool (click to place, then type)
  P = Pen tool (vector paths)
  V = Move/Select tool (default, select and move elements)
  K = Scale tool
  I = Color picker / eyedropper
  Ctrl+D = Duplicate selection
  Ctrl+G = Group selection
  Ctrl+Shift+G = Ungroup
  Ctrl+] = Bring forward
  Ctrl+[ = Send backward
  Ctrl+R = Rename layer
  Ctrl+A = Select all
  Delete/Backspace = Delete selected
  Hold Shift while dragging = constrain proportions
  Hold Alt while dragging = duplicate element
  Ctrl+Z = Undo

DESIGN STRATEGY:
1. FIRST: Create a Frame (F) — this is your artboard. Common sizes:
   - Desktop: 1440×900 or 1920×1080
   - Mobile: 390×844 (iPhone 14)
   - Tablet: 834×1194 (iPad Pro)
2. THEN: Build the layout with nested Frames for sections (header, hero, content, footer)
3. ADD: Rectangles (R) for cards/backgrounds, Text (T) for labels/headings
4. STYLE: Use the right panel to set colors, fonts, spacing, border radius
   - Click element → right panel shows Fill, Stroke, Effects
   - Change fill color: click the color swatch in Fill section
   - Change text: double-click text element to edit
   - Border radius: in the Design panel, look for corner radius field

PROPERTY EDITING (via right panel):
- Position/Size: X, Y, W, H fields at top of Design panel
- Fill: click color swatch → color picker or hex input
- Stroke: add stroke → set color and width
- Effects: add shadow/blur from Effects section
- Text properties: font, size, weight, line height, letter spacing
- Auto Layout: select frame → click "+" next to Auto Layout (or Shift+A)

MAKING IT LOOK PROFESSIONAL:
- Use consistent spacing (8px grid: 8, 16, 24, 32, 48, 64, 96)
- Use a limited color palette (2-3 colors max + neutrals)
- Use font hierarchy (large bold headings, smaller regular body)
- Add subtle shadows for depth (0, 2, 8, rgba(0,0,0,0.1))
- Round corners on cards (8-16px radius)
- Use Auto Layout for responsive sections

IMPORTANT:
- After creating elements, ALWAYS check screenshot to verify placement
- Figma canvas is infinite — start near center (0,0)
- To zoom: Ctrl+mousewheel or Ctrl+= / Ctrl+-
- To pan: Space+drag or middle mouse button
- If you need to edit text, double-click the text element first
- The LEFT panel shows layers, the RIGHT panel shows properties
- AIM FOR WOW — this is a hackathon demo. Make it beautiful!"""

        # Initial prompt with screenshot + DOM snapshot
        nav_context = ""
        if target_url:
            nav_context = f"\nI just navigated to {target_url}. Here is a FRESH screenshot of the loaded page. Analyze it carefully."
        else:
            nav_context = "\nYou are working on the user's CURRENT page. Look at the screenshot — this is what the user sees right now. Work HERE, do NOT navigate away unless the task requires a different site."

        # Get fresh element map (ref IDs for click_by_ref/type_into_ref)
        snap_task_id = task_id if target_url else None
        try:
            gather_result = await _send_action_direct(session_id, {"action": "evaluate", "code": _GATHER_ELEMENTS_JS}, task_id=snap_task_id, timeout=5.0)
            if gather_result.get("success") and gather_result.get("result"):
                raw = gather_result["result"]
                fresh_elems = json.loads(raw) if isinstance(raw, str) else raw
                if isinstance(fresh_elems, list):
                    if task_id:
                        _task_element_maps[task_id] = fresh_elems
                    _element_maps[session_id] = fresh_elems
                    elements = fresh_elems  # Use freshly gathered elements
        except Exception:
            pass
        elem_text = _format_element_map_for_model(elements) if elements else "(no page elements yet)"

        hive_context = _hive_snapshot_for_prompt(session_id)
        # CRITICAL: Screenshot FIRST, then text. The model must SEE the page before reading element IDs.
        initial_parts = []
        if screenshot and len(screenshot) > 1000:
            initial_parts.append(types.Part(inline_data=types.Blob(mime_type="image/jpeg", data=screenshot)))
        initial_parts.append(types.Part(text=f"""TASK: {task}
{category_hints}{nav_context}
{hive_context}

Look at the screenshot above FIRST. Understand what you see, then use the element IDs below.

{elem_text}

Use click_by_ref(ref=N) and type_into_ref(ref=N, text="...") with the #N IDs from PAGE ELEMENTS.
Fall back to click(x,y) ONLY for canvas/drawing or when no ref ID matches.
After each action, you get a NEW screenshot + fresh element map. Check if your action worked.
NEVER call done() until you have visually VERIFIED the result. Maximum {MAX_STEPS} steps."""))

        history = [types.Content(role="user", parts=initial_parts)]
        config = types.GenerateContentConfig(
            system_instruction=EXECUTOR_INSTRUCTION,
            tools=[HYBRID_TOOLS],
            temperature=0.2,
        )

        for step in range(MAX_STEPS):
            # Yield to event loop — critical for keeping Live API audio stream alive
            await asyncio.sleep(0.01)
            print(f"[executor] Step {step + 1}/{MAX_STEPS}")

            # Self-healing DOM: auto-clear popups/modals before each step
            if step > 0:
                try:
                    await _send_action_direct(session_id, {"action": "evaluate", "code": _CLEAR_BLOCKERS_JS}, task_id=task_id, timeout=3.0)
                except Exception:
                    pass

            try:
                _api_calls_session[session_id] = _api_calls_session.get(session_id, 0) + 1
                _api_calls_total += 1
                _imgs_in_hist = sum(1 for c in history for p in (c.parts or []) if hasattr(p, 'inline_data') and p.inline_data)
                if _api_calls_total % 10 == 0 or step == 0:
                    print(f"[COST] API calls total={_api_calls_total} session={_api_calls_session.get(session_id, 0)} (executor step {step+1}, {_imgs_in_hist} imgs in history)")
                response = await genai_client.aio.models.generate_content(
                    model=EXECUTOR_TOOLS_MODEL, contents=history, config=config,
                )
            except Exception as e:
                print(f"[executor] API error at step {step + 1}: {e}")
                result_text = f"Error: {str(e)[:100]}"
                break

            if not response.candidates or not response.candidates[0].content or not response.candidates[0].content.parts:
                print(f"[executor] Empty response at step {step + 1}")
                break

            model_content = response.candidates[0].content
            history.append(model_content)

            # Extract model's reasoning text (ReAct thought) and stream to UI
            # Strict filter: only show actual reasoning sentences, not code/data fragments
            thought_text = ""
            for part in model_content.parts:
                if hasattr(part, 'text') and part.text and part.text.strip():
                    candidate = part.text.strip()
                    # Skip: too short, no spaces, starts with code/data patterns, or contains element map dumps
                    if len(candidate) < 20:
                        continue
                    if ' ' not in candidate:
                        continue
                    if candidate.startswith(('_', '#', '[PAGE', '[Screenshot', '{', '<', '(function', 'var ', 'let ', 'const ', 'document.')):
                        continue
                    # Skip element map patterns: #N TAG, BTN, INPUT, ref IDs, raw DOM data
                    _skip_kws = [
                        'PAGE ELEMENTS', 'data-lobster', 'querySelector', 'getElementById',
                        'function()', '.click(', 'contenteditable', 'inline_data', 'mime_type',
                        '#0 ', '#1 ', '#2 ', 'BTN "', 'INPUT "', 'LINK "', 'A "',
                        'click_by_ref', 'type_into_ref', 'execute_js(',
                        'aria-label', 'placeholder=', 'href=', 'role=',
                        '.textContent', '.innerHTML', '.value',
                    ]
                    if any(kw in candidate for kw in _skip_kws):
                        continue
                    # Skip if >30% of text is element map refs like #N
                    import re as _re
                    _ref_count = len(_re.findall(r'#\d+\s+[A-Z]', candidate))
                    if _ref_count >= 3:
                        continue
                    thought_text = candidate
                    break
            if thought_text and ws:
                try:
                    await ws.send_json({
                        "type": "agent_thought",
                        "thought": thought_text[:400],
                        "task_id": task_id,
                        "step": step + 1,
                    })
                    print(f"[executor] Thought: {thought_text[:120]}")
                except Exception:
                    pass

            # Check for function calls
            function_calls = [p for p in model_content.parts if hasattr(p, 'function_call') and p.function_call]

            if not function_calls:
                # No tool calls = model finished (fallback — prefer explicit done() tool)
                for part in model_content.parts:
                    if hasattr(part, 'text') and part.text:
                        result_text = part.text
                        break
                print(f"[executor] DONE (text): {result_text[:200]}")
                break

            # Loop detection — track last 3 call sets, break hallucination if same action 3x
            current_calls = [(p.function_call.name, str(dict(p.function_call.args) if p.function_call.args else {})) for p in function_calls]
            last_calls_history.append(current_calls)
            if len(last_calls_history) > 5:
                last_calls_history.pop(0)
            # Check if last 3 call sets are identical → hallucination loop
            if len(last_calls_history) >= 3 and last_calls_history[-1] == last_calls_history[-2] == last_calls_history[-3]:
                print(f"[executor] HALLUCINATION LOOP detected at step {step + 1} — same action 3x in a row!")
                # Break the loop: scroll + inject system nudge
                try:
                    await _send_action_direct(session_id, {"action": "scroll", "direction": "down"}, task_id=task_id, timeout=5.0)
                except Exception:
                    pass
                loop_break_parts = [types.Part(text="[SYSTEM] You are stuck in a LOOP — repeating the same action 3 times. STOP and try a COMPLETELY DIFFERENT approach. Look at the new screenshot, re-read [PAGE ELEMENTS], and find a different element or strategy. If the element you're targeting doesn't respond, try execute_js or a different selector.")]
                # Get fresh screenshot after scroll
                try:
                    _ws = _websockets.get(session_id)
                    if _ws:
                        await _ws.send_json({"type": "request_screenshot", "task_id": task_id})
                        await asyncio.sleep(0.5)
                    fresh_ss = _task_screenshots.get(task_id)
                    if fresh_ss and len(fresh_ss) > 1000:
                        loop_break_parts.append(types.Part(inline_data=types.Blob(mime_type="image/jpeg", data=fresh_ss)))
                except Exception:
                    pass
                history.append(types.Content(role="user", parts=loop_break_parts))
                last_calls_history.clear()
                continue  # Skip normal result processing, let LLM re-evaluate

            # Execute each tool call and collect results
            response_parts = []
            done_flag = False
            for fc_part in function_calls:
                fc = fc_part.function_call
                fc_name = fc.name
                fc_args = dict(fc.args) if fc.args else {}
                print(f"[executor] Tool: {fc_name}({json.dumps(fc_args, ensure_ascii=False)[:150]})")

                # Send step progress to frontend — descriptive labels with element context
                if ws:
                    # Helper: look up element label from element map by ref ID
                    def _ref_label(ref_id) -> str:
                        try:
                            ref_int = int(ref_id)
                            elems = _task_element_maps.get(task_id) or _element_maps.get(session_id, [])
                            for el in elems:
                                if el.get("id") == ref_int:
                                    lbl = el.get("label", "")
                                    tag = el.get("tag", "")
                                    if lbl and lbl != tag:
                                        return f'"{lbl[:25]}"'
                                    return f"#{ref_id} {tag}"
                        except (ValueError, TypeError):
                            pass
                        return f"#{ref_id}"

                    if fc_name == "navigate":
                        url_short = fc_args.get("url", "")[:40]
                        label = f"Opening {url_short}" if url_short else "Navigating"
                        tool_type = "navigate"
                    elif fc_name == "execute_js":
                        label = "Running script"
                        tool_type = "code"
                    elif fc_name in ("drag", "draw_path"):
                        desc = fc_args.get("description", "")
                        label = f"Drawing · {desc[:25]}" if desc else "Drawing"
                        tool_type = "draw"
                    elif fc_name == "click":
                        x, y = fc_args.get("x", "?"), fc_args.get("y", "?")
                        label = f"Clicking at ({x}, {y})"
                        tool_type = "click"
                    elif fc_name == "type_text":
                        txt = fc_args.get("text", "")[:25]
                        label = f'Typing "{txt}"' if txt else "Typing"
                        tool_type = "type"
                    elif fc_name == "press_key":
                        label = f"Pressing {fc_args.get('key', '?')}"
                        tool_type = "key"
                    elif fc_name == "scroll":
                        label = f"Scrolling {fc_args.get('direction', 'down')}"
                        tool_type = "scroll"
                    elif fc_name == "click_by_ref":
                        ref = fc_args.get("ref", "?")
                        label = f"Clicking {_ref_label(ref)}"
                        tool_type = "click"
                    elif fc_name == "type_into_ref":
                        ref = fc_args.get("ref", "?")
                        txt = fc_args.get("text", "")[:20]
                        label = f'Typing "{txt}" into {_ref_label(ref)}' if txt else f"Typing into {_ref_label(ref)}"
                        tool_type = "type"
                    elif fc_name == "wait_for":
                        cond = fc_args.get("condition", "")
                        target = fc_args.get("target", "")[:20]
                        label = f"Waiting for {target}" if target else f"Waiting · {cond}"
                        tool_type = "code"
                    elif fc_name == "generate_image":
                        label = "Generating image"
                        tool_type = "draw"
                    elif fc_name == "done":
                        summary = fc_args.get("summary", "")[:30]
                        label = f"Done · {summary}" if summary else "Finishing"
                        tool_type = "done"
                    else:
                        label = fc_name
                        tool_type = "code"
                    try:
                        await ws.send_json({"type": "task_progress", "status": "step", "task_id": task_id, "step": step + 1, "max_steps": MAX_STEPS, "action": label, "tool_type": tool_type})
                        await ws.send_json({"type": "tool_activity", "tool": fc_name, "label": label, "task_id": task_id, "tool_type": tool_type})
                    except Exception:
                        pass

                # Yield to event loop between tool calls — keeps Live API audio flowing
                await asyncio.sleep(0.01)

                # Handle done() tool — explicit completion signal
                if fc_name == "done":
                    result_text = fc_args.get("summary", "Task complete.")
                    # VERIFICATION: Request fresh screenshot from agent's own tab, then verify
                    try:
                        await ws.send_json({"type": "request_screenshot", "task_id": task_id})
                        await asyncio.sleep(1.5)  # Wait for screenshot to arrive
                    except Exception:
                        pass
                    # Use ONLY the task's own screenshot — NEVER fall back to session (user's view)
                    verify_ss = _task_screenshots.get(task_id)
                    if verify_ss and len(verify_ss) > 1000 and step < MAX_STEPS - 1:
                        verify_contents = [types.Content(parts=[
                            types.Part(text=f"You called done(\"{result_text}\"). VERIFY: Look at this FINAL screenshot carefully. Does it CONFIRM the task was actually completed successfully? Answer ONLY 'CONFIRMED' or 'FAILED: reason'."),
                            types.Part(inline_data=types.Blob(mime_type="image/jpeg", data=verify_ss)),
                        ], role="user")]
                        try:
                            verify_resp = await genai_client.aio.models.generate_content(
                                model=EXECUTOR_TOOLS_MODEL, contents=verify_contents,
                                config=types.GenerateContentConfig(temperature=0.1, max_output_tokens=150),
                            )
                            vtext = (verify_resp.text or "").strip()
                            print(f"[executor] VERIFY response: {vtext[:200]}")
                            if vtext.startswith("FAILED"):
                                # Verification failed — inject feedback and continue
                                print(f"[executor] VERIFY REJECTED: {vtext[:200]}")
                                response_parts.append(types.Part(
                                    function_response=types.FunctionResponse(name=fc_name, response={
                                        "status": "verification_failed",
                                        "message": f"Verification rejected: {vtext}. Look at the screenshot again — the task is NOT done. Take corrective action."
                                    })
                                ))
                                continue
                        except Exception as ve:
                            print(f"[executor] Verify error (proceeding anyway): {ve}")
                    response_parts.append(types.Part(
                        function_response=types.FunctionResponse(name=fc_name, response={"status": "done", "summary": result_text})
                    ))
                    done_flag = True
                    print(f"[executor] DONE (verified): {result_text[:200]}")
                    break

                # Handle Hive Memory tools (local, no Electron IPC)
                if fc_name == "write_to_hive":
                    _hive_write(session_id, fc_args.get("key", ""), fc_args.get("value", ""), source_task=task_id)
                    response_parts.append(types.Part(
                        function_response=types.FunctionResponse(name=fc_name, response={"status": "stored", "key": fc_args.get("key", "")})
                    ))
                    continue
                if fc_name == "read_from_hive":
                    hive_result = _hive_read(session_id, fc_args.get("key", "*"))
                    response_parts.append(types.Part(
                        function_response=types.FunctionResponse(name=fc_name, response=hive_result)
                    ))
                    continue

                # Execute tool — sends action to Electron (bulletproof error boundary)
                try:
                    tool_result = await asyncio.wait_for(
                        _execute_tool(session_id, fc_name, fc_args, task_id=task_id),
                        timeout=30.0,
                    )
                except asyncio.TimeoutError:
                    tool_result = {"status": "timeout", "error": f"Tool '{fc_name}' timed out after 30s. The page may be unresponsive. Try a different approach or navigate to a different page."}
                    print(f"[executor] TIMEOUT: {fc_name}")
                except Exception as e:
                    tool_result = {"status": "execution_failed", "error": str(e)[:200], "hint": "This tool crashed. Try a different tool or approach."}
                    print(f"[executor] CRASH in {fc_name}: {e}")
                print(f"[executor] Result: {str(tool_result)[:150]}")

                response_parts.append(types.Part(
                    function_response=types.FunctionResponse(name=fc_name, response=tool_result)
                ))

            if done_flag:
                break

            # Wait for page to settle — longer after navigate/draw, shorter after JS
            action_names = {p.function_call.name for p in function_calls if hasattr(p, 'function_call') and p.function_call}
            if "navigate" in action_names:
                await asyncio.sleep(2.5)  # Page load
            elif action_names & {"drag", "draw_path"}:
                await asyncio.sleep(1.0)  # Ghost cursor animation + canvas processing
            elif "press_key" in action_names:
                await asyncio.sleep(0.8)  # Keyboard shortcuts need time for toolbar update
            elif action_names & {"click", "type_text", "click_by_ref", "type_into_ref"}:
                await asyncio.sleep(0.5)  # Brief settle for click/type events
            elif "wait_for" in action_names:
                await asyncio.sleep(0.1)  # wait_for already waited internally
            else:
                await asyncio.sleep(0.3)  # JS is instant

            # Get fresh screenshot — SKIP for read-only JS (saves ~3k tokens per step)
            _js_read_only = (action_names == {"execute_js"}) and all(
                not any(kw in (p.function_call.args.get("code", "") or "") for kw in [
                    ".click(", ".submit(", ".value", "innerHTML", "textContent =",
                    "dispatchEvent", ".remove(", ".appendChild", ".insertBefore",
                ])
                for p in function_calls if hasattr(p, 'function_call') and p.function_call
            )
            if _js_read_only:
                response_parts.append(types.Part(text="[Screenshot skipped — JS was read-only, no visual change]"))
            else:
                # Request fresh per-task screenshot after tool execution
                _ws = _websockets.get(session_id)
                if _ws:
                    try:
                        await _ws.send_json({"type": "request_screenshot", "task_id": task_id})
                        await asyncio.sleep(0.3)  # Brief wait for capture
                    except Exception:
                        pass
                fresh_ss = _task_screenshots.get(task_id)
                if fresh_ss and len(fresh_ss) > 1000:
                    response_parts.append(types.Part(inline_data=types.Blob(mime_type="image/jpeg", data=fresh_ss)))

            # Get fresh element map (ref IDs for click_by_ref/type_into_ref)
            try:
                gather_result = await _send_action_direct(session_id, {"action": "evaluate", "code": _GATHER_ELEMENTS_JS}, task_id=task_id, timeout=5.0)
                if gather_result.get("success") and gather_result.get("result"):
                    raw = gather_result["result"]
                    elements = json.loads(raw) if isinstance(raw, str) else raw
                    if isinstance(elements, list):
                        if task_id:
                            _task_element_maps[task_id] = elements
                        _element_maps[session_id] = elements
                        elem_text = _format_element_map_for_model(elements)
                        if elem_text:
                            response_parts.append(types.Part(text=f"\n{elem_text}"))
            except Exception:
                pass

            history.append(types.Content(role="user", parts=response_parts))

            # ── COST OPTIMIZATION: Truncate old screenshots from history ──
            # Keep only last 3 user messages' screenshots — older ones replaced with text placeholder.
            # This prevents O(n²) token growth: step 10 would otherwise re-read all 10 screenshots.
            if len(history) > 8:  # 4+ user/model pairs = older screenshots can be pruned
                for old_content in history[:-6]:  # Keep last 3 user+model pairs intact
                    if old_content.role == "user" and old_content.parts:
                        old_content.parts = [
                            p if not (hasattr(p, 'inline_data') and p.inline_data)
                            else types.Part(text="[previous screenshot omitted to save tokens]")
                            for p in old_content.parts
                        ]

        # ── SWARM CHECK: Is this task part of a Tab Swarm? ──
        swarm_entry = None
        for sw_id, sw in _swarm_tracker.items():
            if task_id in sw.get("task_ids", []):
                swarm_entry = (sw_id, sw)
                break

        if swarm_entry:
            sw_id, sw = swarm_entry
            sw["results"][task_id] = result_text[:500]
            all_done = len(sw["results"]) >= len(sw["task_ids"])
            print(f"[swarm] {sw_id}: {len(sw['results'])}/{len(sw['task_ids'])} done (task {task_id})")

            # Notify frontend of individual task completion + swarm status
            if ws:
                try:
                    await ws.send_json({"type": "task_progress", "status": "done", "result": result_text[:500], "task_id": task_id})
                    # Send swarm status update
                    subtask_statuses = []
                    for i, tid in enumerate(sw["task_ids"]):
                        url = sw["targets"][i] if i < len(sw["targets"]) else "?"
                        desc = sw.get("subtask_descs", sw["targets"])[i] if i < len(sw.get("subtask_descs", sw["targets"])) else sw["task"]
                        st = "done" if tid in sw["results"] else "running"
                        subtask_statuses.append({"task": desc[:60], "url": url, "taskId": tid, "status": st})
                    await ws.send_json({"type": "swarm_status", "swarm_id": sw_id, "status": "active", "subtasks": subtask_statuses})
                except Exception:
                    pass

            if all_done:
                # ── SWARM AGGREGATION: All parallel tasks finished ──
                print(f"[swarm] {sw_id}: ALL DONE — aggregating results")
                agg_lines = [f"Tab Swarm complete — compared '{sw['task']}' across {len(sw['targets'])} sites:\n"]
                for i, tid in enumerate(sw["task_ids"]):
                    url = sw["targets"][i] if i < len(sw["targets"]) else "?"
                    res = sw["results"].get(tid, "No result")
                    agg_lines.append(f"## {url}\n{res[:300]}\n")
                aggregated = "\n".join(agg_lines)

                # ── Send status to frontend FIRST so conductor is shown as active ──
                if ws:
                    try:
                        await ws.send_json({"type": "status", "state": "thinking"})
                        await ws.send_json({
                            "type": "transcript",
                            "text": f"[Lobster]: Tab Swarm zakończony — {len(sw['targets'])} stron porównanych!",
                            "replace": False,
                        })
                        # Final swarm status — all done
                        await ws.send_json({"type": "swarm_status", "swarm_id": sw_id, "status": "done", "subtasks": []})
                    except Exception:
                        pass

                # ── Force-clear audio mute BEFORE handoff so conductor can speak ──
                _audio_mute_until_map[session_id] = 0
                await asyncio.sleep(1.5)  # Brief delay for conductor audio stream readiness

                live_queue = _live_queues.get(session_id)
                if live_queue:
                    try:
                        _handoff_pending[session_id] = True
                        live_queue.send_content(types.Content(parts=[
                            types.Part(text=f"URGENT — YOU MUST SPEAK NOW. DO NOT STAY SILENT.\n\nTab Swarm finished! Here are the combined results:\n{aggregated}\n\nSummarize the comparison to the user RIGHT NOW. Highlight key differences, which is best/cheapest/fastest. Speak in the user's language. Be concise — 3-5 sentences max. START SPEAKING IMMEDIATELY.")
                        ]))
                        _append_conversation(session_id, "agent", f"[Swarm result: {aggregated[:300]}]")
                    except Exception as e:
                        print(f"[swarm] Aggregation handoff error: {e}")

                # Cleanup swarm tracker
                _swarm_tracker.pop(sw_id, None)
        else:
            # ── NORMAL HANDOFF: Inject result back into Conductor ──
            short_result = result_text[:200].rsplit('.', 1)[0] or result_text[:150]
            live_queue = _live_queues.get(session_id)
            if live_queue:
                try:
                    _handoff_pending[session_id] = True  # Signal downstream to open audio gate
                    live_queue.send_content(types.Content(parts=[
                        types.Part(text=f"IMPORTANT: A task just finished. Results: {short_result}. You MUST speak now — tell the user what happened in 1-2 sentences. Speak in the same language as the user. Be enthusiastic and clear.")
                    ]))
                    print(f"[executor] Handoff sent to Conductor ({len(short_result)} chars)")
                    # Store task result in conversation history for reconnect context
                    _append_conversation(session_id, "agent", f"[Task result: {short_result}]")
                    # Reset audio mute so conductor can speak immediately
                    _audio_mute_until_map.pop(session_id, None)
                except Exception as e:
                    print(f"[executor] Handoff error: {e}")

            # Notify frontend — always send transcript as fallback in case conductor stays silent
            if ws:
                try:
                    await ws.send_json({"type": "task_progress", "status": "done", "result": result_text[:500], "task_id": task_id})
                    await ws.send_json({"type": "status", "state": "thinking"})
                    # Direct transcript fallback — shown in UI immediately
                    await ws.send_json({"type": "transcript", "text": f"[Lobster]: {short_result}", "replace": False})
                except Exception:
                    pass

        # Safety: if Conductor doesn't respond within 15s, force idle
        async def _force_idle_fallback():
            await asyncio.sleep(15)
            ws2 = _websockets.get(session_id)
            if ws2:
                try:
                    await ws2.send_json({"type": "status", "state": "idle"})
                except Exception:
                    pass
        asyncio.create_task(_force_idle_fallback())

    except asyncio.CancelledError:
        print(f"[executor] Task cancelled [{task_id}]: {task[:50]}")
        if ws:
            try:
                await ws.send_json({"type": "task_progress", "status": "cancelled", "task_id": task_id})
            except Exception:
                pass
        # Mark cancelled task in swarm tracker so aggregation isn't stuck
        for sw_id, sw in list(_swarm_tracker.items()):
            if task_id in sw.get("task_ids", []):
                sw["results"][task_id] = "[Task cancelled]"
                if len(sw["results"]) >= len(sw["task_ids"]):
                    _swarm_tracker.pop(sw_id, None)
                break
    except Exception as e:
        print(f"[executor] FATAL [{task_id}]: {e}")
        traceback.print_exc()
        if ws:
            try:
                await ws.send_json({"type": "task_progress", "status": "error", "error": str(e)[:200], "task_id": task_id})
            except Exception:
                pass
        # Mark errored task in swarm tracker so aggregation isn't stuck
        for sw_id, sw in list(_swarm_tracker.items()):
            if task_id in sw.get("task_ids", []):
                sw["results"][task_id] = f"[Error: {str(e)[:100]}]"
                if len(sw["results"]) >= len(sw["task_ids"]):
                    _swarm_tracker.pop(sw_id, None)
                break
    finally:
        active = _executor_active.get(session_id, set())
        active.discard(task_id)
        _task_result_queues.pop(task_id, None)
        _task_screenshots.pop(task_id, None)
        _task_element_maps.pop(task_id, None)
        _task_image_generated.pop(task_id, None)
        if session_id in _executor_tasks:
            _executor_tasks[session_id].pop(task_id, None)


# ── Cron job runner ──

async def _run_cron_job(job_id: str):
    """Recurring task runner. Runs executor on schedule, reports back to Conductor."""
    global _api_calls_total
    job = _cron_jobs.get(job_id)
    if not job:
        return
    sid = job["session_id"]
    task = job["task"]
    category = job.get("category", "browser")
    # NOTE: interval is read from _cron_jobs dict on each tick so edits take effect immediately

    interval = job.get("interval", 60)
    print(f"[cron] Started job '{job_id}': '{task}' every {interval}s")

    # Notify frontend
    ws = _websockets.get(sid)
    if ws:
        try:
            await ws.send_json({
                "type": "cron_update", "job_id": job_id,
                "status": "started", "task": task, "interval": interval,
            })
        except Exception:
            pass

    tick = 0
    try:
        # Pre-navigate to target URL immediately so the tab shows up right away
        pre_url = _cron_jobs.get(job_id, {}).get("base_url")
        if pre_url:
            try:
                print(f"[cron] Pre-navigating to {pre_url[:60]} for immediate tab association")
                cron_task_id_init = f"cron_{job_id}"
                if sid not in _executor_active:
                    _executor_active[sid] = set()
                _task_result_queues[cron_task_id_init] = asyncio.Queue()
                await _send_action_direct(sid, {"action": "navigate", "url": pre_url}, task_id=cron_task_id_init)
                _task_result_queues.pop(cron_task_id_init, None)
                await asyncio.sleep(1)
                # Notify frontend with URL so tab merges immediately
                if ws:
                    await ws.send_json({
                        "type": "cron_update", "job_id": job_id,
                        "status": "running", "tick": 0, "url": pre_url,
                    })
            except Exception as e:
                print(f"[cron] Pre-navigate failed: {e}")

        while job_id in _cron_jobs:
            tick += 1
            job = _cron_jobs.get(job_id)
            if not job:
                break

            # Wait for interval (skip on tick 1 — run immediately)
            # Read interval from dict each tick so edits take effect immediately
            interval = _cron_jobs.get(job_id, {}).get("interval", 60)
            if tick > 1:
                await asyncio.sleep(interval)
            if job_id not in _cron_jobs:
                break

            # Clean stale _executor_active entries (tasks that finished but weren't removed due to race)
            active = _executor_active.get(sid, set())
            tasks_map = _executor_tasks.get(sid, {})
            stale = {tid for tid in active if not tid.startswith("cron_") and (tid not in tasks_map or tasks_map.get(tid, None) is None or (hasattr(tasks_map.get(tid), 'done') and tasks_map[tid].done()))}
            for tid in stale:
                active.discard(tid)
                tasks_map.pop(tid, None)
            if stale:
                print(f"[cron] Cleaned {len(stale)} stale active entries: {stale}")

            # Check if too many concurrent tasks — cron doesn't count against regular tasks
            non_cron_active = {t for t in active if not t.startswith("cron_")}
            if len(non_cron_active) >= MAX_CONCURRENT_TASKS:
                print(f"[cron] Job '{job_id}' tick #{tick}: {len(non_cron_active)} user tasks running, skipping")
                continue

            print(f"[cron] Job '{job_id}' tick #{tick}: running executor")

            # Track this cron as active
            cron_task_id = f"cron_{job_id}"
            if sid not in _executor_active:
                _executor_active[sid] = set()
            _executor_active[sid].add(cron_task_id)
            _task_result_queues[cron_task_id] = asyncio.Queue()
            ws = _websockets.get(sid)
            try:
                if ws:
                    try:
                        stored_url = _cron_jobs.get(job_id, {}).get("url")
                        await ws.send_json({
                            "type": "cron_update", "job_id": job_id,
                            "status": "running", "tick": tick,
                            "task_id": cron_task_id,
                            **({"url": stored_url} if stored_url else {}),
                        })
                    except Exception:
                        pass

                # ALWAYS refresh the target page so cron sees fresh content
                stored_url = _cron_jobs.get(job_id, {}).get("base_url") or _cron_jobs.get(job_id, {}).get("url")
                if stored_url:
                    try:
                        print(f"[cron] Navigating to target: {stored_url[:60]}")
                        await _send_action_direct(sid, {"action": "navigate", "url": stored_url}, task_id=cron_task_id, timeout=15.0)
                        await asyncio.sleep(2.5)  # Wait for page load
                    except Exception as e:
                        print(f"[cron] Navigate failed: {e}")
                else:
                    print(f"[cron] No stored URL — running executor on current page")

                # Build executor context with fresh screenshot
                screenshot = _task_screenshots.get(cron_task_id) or _screenshots.get(sid)
                elements = _task_element_maps.get(cron_task_id) or _element_maps.get(sid, [])
                elem_text = _format_element_map_for_model(elements) if elements else "(no page elements)"

                # Re-read task text each tick (edits take effect immediately)
                task = _cron_jobs.get(job_id, {}).get("task", task)
                # Determine target URL — use base_url if available
                target_url = _cron_jobs.get(job_id, {}).get("base_url") or ""
                target_note = f'\nTARGET URL: {target_url}\nYou are ALREADY on this page. Do NOT navigate anywhere else.' if target_url else ''

                # Get element map for ref-based tools
                dom_snapshot_text = ""
                try:
                    gather_r = await _send_action_direct(sid, {"action": "evaluate", "code": _GATHER_ELEMENTS_JS}, task_id=cron_task_id, timeout=5.0)
                    if gather_r.get("success") and gather_r.get("result"):
                        raw = gather_r["result"]
                        elems = json.loads(raw) if isinstance(raw, str) else raw
                        if isinstance(elems, list):
                            _task_element_maps[cron_task_id] = elems
                            _element_maps[sid] = elems
                            dom_snapshot_text = f"\n{_format_element_map_for_model(elems)}"
                except Exception:
                    pass

                # Hive Memory context — previous tick results
                hive_data = _HIVE_MEMORY.get(sid, {})
                prev_results = {k: v["value"] for k, v in hive_data.items() if k.startswith(f"cron_{job_id}")}
                hive_text = ""
                if prev_results:
                    hive_entries = list(prev_results.items())[-3:]  # Last 3 results
                    hive_text = "\nPREVIOUS RESULTS (from Hive Memory):\n" + "\n".join(
                        f"  - {k}: {v[:200]}" for k, v in hive_entries
                    ) + "\n"

                cron_task = f"""AUTONOMOUS RECURRING TASK (tick #{tick}): {task}
{target_note}
{hive_text}
RULES:
1. You are on the target page. Analyze what's visible.
2. If the task requires ACTION (comment, like, post, click, upvote) → DO IT using execute_js, click_by_ref, or type_into_ref. DO NOT just read — ACT.
3. If the task is monitoring only → read content via execute_js and report changes.
4. Check Hive Memory for context from previous ticks. ADAPT your approach based on what changed.
5. Use execute_js to read DOM content (post titles, comments, prices, etc.).
6. For inputs (comment boxes, search fields) → use type_into_ref or the React value setter pattern in execute_js.
7. For clicking buttons/links → use click_by_ref with element reference IDs from PAGE ELEMENTS.
8. ALWAYS store your findings via write_to_hive("cron_{job_id}_tick{tick}", "summary of what you found/did") before calling done().
9. If monitoring: compare with previous data, report CHANGES only.
10. Be efficient — act quickly, report via done().
11. Do NOT navigate away from the current page.
{dom_snapshot_text}

STEPS:
1. Scan page content via execute_js (document.body.innerText or specific selectors)
2. If action needed: interact (click_by_ref, type_into_ref, execute_js with .click())
3. Store findings in Hive Memory: write_to_hive("cron_{job_id}_tick{tick}", "summary")
4. Report what you did/found via done(summary)"""
                initial_parts = [types.Part(text=f"Task: {cron_task}")]
                if screenshot and len(screenshot) > 1000:
                    initial_parts.append(types.Part(
                        inline_data=types.Blob(mime_type="image/jpeg", data=screenshot)
                    ))

                history = [types.Content(role="user", parts=initial_parts)]
                config = types.GenerateContentConfig(
                    system_instruction=EXECUTOR_INSTRUCTION,
                    tools=[HYBRID_TOOLS],
                    temperature=0.2,
                )

                result_text = "No changes."
                MAX_CRON_STEPS = 10  # Increased to allow multi-step actions (comment, like, etc.)
                last_cron_calls = []  # Loop detection
                cron_url = None  # Track which URL this cron navigated to

                for step in range(MAX_CRON_STEPS):
                    print(f"[cron] Job '{job_id}' tick #{tick} step {step + 1}/{MAX_CRON_STEPS}")
                    try:
                        _api_calls_session[sid] = _api_calls_session.get(sid, 0) + 1
                        _api_calls_total += 1
                        if _api_calls_total % 10 == 0 or step == 0:
                            print(f"[COST] API calls total={_api_calls_total} (cron '{job_id}' tick#{tick} step {step+1})")
                        response = await genai_client.aio.models.generate_content(
                            model=EXECUTOR_TOOLS_MODEL, contents=history, config=config,
                        )
                    except Exception as e:
                        print(f"[cron] API error: {e}")
                        result_text = f"Error: {str(e)[:100]}"
                        break

                    if not response.candidates or not response.candidates[0].content or not response.candidates[0].content.parts:
                        break

                    model_content = response.candidates[0].content
                    history.append(model_content)

                    function_calls = [p for p in model_content.parts if hasattr(p, 'function_call') and p.function_call]

                    if function_calls:
                        # Loop detection
                        current_calls = [(p.function_call.name, str(dict(p.function_call.args) if p.function_call.args else {})) for p in function_calls]
                        last_cron_calls.append(current_calls)
                        if len(last_cron_calls) > 3:
                            last_cron_calls.pop(0)
                        if len(last_cron_calls) >= 2 and last_cron_calls[-1] == last_cron_calls[-2]:
                            print(f"[cron] LOOP DETECTED at step {step + 1}. Forcing completion.")
                            history.append(types.Content(role="user", parts=[
                                types.Part(text="STOP. You are stuck in a loop. Summarize what you actually accomplished.")
                            ]))
                            continue

                        response_parts = []
                        done_flag = False
                        for fc_part in function_calls:
                            fc = fc_part.function_call
                            fc_args = dict(fc.args) if fc.args else {}
                            print(f"[cron] Tool: {fc.name}({json.dumps(fc_args, ensure_ascii=False)[:150]})")

                            if fc.name == "navigate":
                                label = "Navigating..."
                            elif fc.name == "execute_js":
                                label = "Running JS..."
                            elif fc.name in ("drag", "draw_path"):
                                label = "Drawing..."
                            elif fc.name == "click":
                                label = f"Clicking ({fc_args.get('x', '?')},{fc_args.get('y', '?')})"
                            else:
                                label = fc.name
                            # Track URL for tab association
                            if fc.name == "navigate":
                                nav_url = fc_args.get("url", "")
                                if nav_url and not nav_url.startswith("http"):
                                    nav_url = f"https://{nav_url}"
                                if nav_url:
                                    cron_url = nav_url
                            if cron_url and job_id in _cron_jobs:
                                _cron_jobs[job_id]["url"] = cron_url
                                if fc.name == "navigate" and "base_url" not in _cron_jobs[job_id]:
                                    _cron_jobs[job_id]["base_url"] = cron_url
                                    print(f"[cron] BASE URL locked: {cron_url[:80]}")
                            if ws:
                                try:
                                    await ws.send_json({"type": "tool_activity", "tool": fc.name, "label": f"[Cron] {label}", "task_id": cron_task_id})
                                    await ws.send_json({
                                        "type": "cron_update", "job_id": job_id,
                                        "status": "step", "action": label,
                                        "step": step + 1, "max_steps": MAX_CRON_STEPS,
                                        "task_id": cron_task_id,
                                        **({"url": cron_url} if cron_url else {}),
                                    })
                                except Exception:
                                    pass

                            # Handle done() tool — explicit completion
                            if fc.name == "done":
                                result_text = fc_args.get("summary", "Done.")
                                response_parts.append(types.Part(
                                    function_response=types.FunctionResponse(name=fc.name, response={"status": "done", "summary": result_text})
                                ))
                                done_flag = True
                                print(f"[cron] DONE (explicit): {result_text[:200]}")
                                break

                            # Handle Hive Memory tools (local)
                            if fc.name == "write_to_hive":
                                _hive_write(sid, fc_args.get("key", ""), fc_args.get("value", ""), source_task=cron_task_id)
                                response_parts.append(types.Part(
                                    function_response=types.FunctionResponse(name=fc.name, response={"status": "stored", "key": fc_args.get("key", "")})
                                ))
                                continue
                            if fc.name == "read_from_hive":
                                hive_result = _hive_read(sid, fc_args.get("key", "*"))
                                response_parts.append(types.Part(
                                    function_response=types.FunctionResponse(name=fc.name, response=hive_result)
                                ))
                                continue

                            tool_result = await _execute_tool(sid, fc.name, fc_args, task_id=cron_task_id)
                            response_parts.append(types.Part(
                                function_response=types.FunctionResponse(name=fc.name, response=tool_result)
                            ))

                        if done_flag:
                            break

                        await asyncio.sleep(0.5)
                        fresh_ss = _task_screenshots.get(cron_task_id) or _screenshots.get(sid)

                        if fresh_ss and len(fresh_ss) > 1000:
                            response_parts.append(types.Part(
                                inline_data=types.Blob(mime_type="image/jpeg", data=fresh_ss)
                            ))

                        # Get fresh element map for next step
                        try:
                            gather_r2 = await _send_action_direct(sid, {"action": "evaluate", "code": _GATHER_ELEMENTS_JS}, task_id=cron_task_id, timeout=5.0)
                            if gather_r2.get("success") and gather_r2.get("result"):
                                raw2 = gather_r2["result"]
                                elems2 = json.loads(raw2) if isinstance(raw2, str) else raw2
                                if isinstance(elems2, list):
                                    _task_element_maps[cron_task_id] = elems2
                                    _element_maps[sid] = elems2
                                    response_parts.append(types.Part(text=f"\n{_format_element_map_for_model(elems2)}"))
                        except Exception:
                            pass

                        history.append(types.Content(role="user", parts=response_parts))

                        # COST OPTIMIZATION: Truncate old screenshots (same as regular executor)
                        if len(history) > 6:
                            for old_content in history[:-4]:
                                if old_content.role == "user" and old_content.parts:
                                    old_content.parts = [
                                        p if not (hasattr(p, 'inline_data') and p.inline_data)
                                        else types.Part(text="[previous screenshot omitted]")
                                        for p in old_content.parts
                                    ]
                    else:
                        for part in model_content.parts:
                            if hasattr(part, 'text') and part.text:
                                result_text = part.text
                                break
                        break

                # Store last result
                if job_id in _cron_jobs:
                    _cron_jobs[job_id]["last_result"] = result_text

                # ALWAYS report to Conductor via voice — user wants to know what happened
                live_queue = _live_queues.get(sid)
                short = result_text[:250] if len(result_text) > 250 else result_text
                if live_queue:
                    try:
                        _handoff_pending[sid] = True
                        # Reset audio mute so Conductor can actually speak
                        _audio_mute_until_map[sid] = 0
                        live_queue.send_content(types.Content(parts=[
                            types.Part(text=f"CRON UPDATE — Task done: '{task}' (tick #{tick}). Results: {short}. You MUST tell the user what was found. Summarize in 1-2 sentences in their language. Do NOT stay silent!")
                        ]))
                        # Poke harder on repeat ticks — conductor sometimes ignores first handoff
                        if tick > 1:
                            live_queue.send_content(types.Content(parts=[
                                types.Part(text=f"IMPORTANT CRON UPDATE: Recurring check #{tick} for '{task}'. Results: {short[:150]}. SPEAK NOW — the user is waiting for this update!")
                            ]))
                        print(f"[cron] Reported to Conductor (tick {tick}): {short[:80]}")
                    except Exception as e:
                        print(f"[cron] Report to Conductor failed: {e}")

                # Notify frontend — direct transcript + cron status
                if ws:
                    try:
                        final_url = cron_url or _cron_jobs.get(job_id, {}).get("url")
                        # Direct transcript fallback — user sees cron result even if conductor stays silent
                        await ws.send_json({"type": "transcript", "text": f"[Cron #{tick}] {short[:200]}", "replace": False})
                        await ws.send_json({
                            "type": "cron_update", "job_id": job_id,
                            "status": "tick_done", "tick": tick,
                            "result": result_text[:300],
                            **({"url": final_url} if final_url else {}),
                        })
                    except Exception:
                        pass

                print(f"[cron] Job '{job_id}' tick #{tick} done: {result_text[:100]}")

            except Exception as e:
                print(f"[cron] Job '{job_id}' tick #{tick} error: {e}")
                traceback.print_exc()
            finally:
                active = _executor_active.get(sid, set())
                active.discard(cron_task_id)
                _task_result_queues.pop(cron_task_id, None)
                _task_screenshots.pop(cron_task_id, None)
                _task_element_maps.pop(cron_task_id, None)

    except asyncio.CancelledError:
        print(f"[cron] Job '{job_id}' cancelled")
    finally:
        _cron_jobs.pop(job_id, None)
        ws = _websockets.get(sid)
        if ws:
            try:
                await ws.send_json({
                    "type": "cron_update", "job_id": job_id, "status": "stopped",
                })
            except Exception:
                pass
        print(f"[cron] Job '{job_id}' removed")


# ══════════════════════════════════════════════════════════════════════
# ADK AGENT + RUNNER (Conductor only — router tools + cron tools)
# ══════════════════════════════════════════════════════════════════════

agent = Agent(
    name="lobster_conductor",
    model=CONDUCTOR_MODEL,
    instruction=CONDUCTOR_INSTRUCTION,
    tools=ROUTER_TOOLS,
)

APP_NAME = "lobster-browser"
session_service = InMemorySessionService()
runner = Runner(
    app_name=APP_NAME,
    agent=agent,
    session_service=session_service,
)


# ══════════════════════════════════════════════════════════════════════
# ENDPOINTS
# ══════════════════════════════════════════════════════════════════════

@app.get("/health")
async def health():
    return {"status": "ok", "service": "lobster-backend", "version": "2.0.0", "architecture": "two-brain"}


@app.websocket("/ws/{user_id}/{session_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: str, session_id: str):
    """WebSocket bridge: Electron ↔ ADK Conductor ↔ Gemini Live API.
    Screenshots are stored for the Executor but NEVER sent to the Conductor."""
    await websocket.accept()
    print(f"[session] Connected: {user_id}/{session_id}")

    adk_session = await session_service.get_session(
        app_name=APP_NAME, user_id=user_id, session_id=session_id,
    )
    if not adk_session:
        adk_session = await session_service.create_session(
            app_name=APP_NAME, user_id=user_id, session_id=session_id,
            state={"_session_id": session_id},
        )

    # Per-session shared state
    _action_queues[session_id] = asyncio.Queue()
    _result_queues[session_id] = asyncio.Queue()
    _websockets[session_id] = websocket
    _element_maps[session_id] = []

    live_request_queue = LiveRequestQueue()
    _live_queues[session_id] = live_request_queue

    run_config = RunConfig(
        response_modalities=[types.Modality.AUDIO],
        streaming_mode=StreamingMode.BIDI,
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Puck")
            ),
        ),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        realtime_input_config=types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(
                disabled=False,
                start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_HIGH,
                end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_LOW,
                prefix_padding_ms=300,
                silence_duration_ms=1000,
            )
        ),
    )

    client_alive = True
    turn_text = ""  # Accumulated transcription for current turn
    # Diagnostic counters
    _audio_packets_sent = 0
    _screenshots_stored = 0
    _events_received = 0
    _last_event_time = time.time()
    _force_reconnect = False
    # No suppression — agent greets and speaks from the start
    _suppress_prime = False
    # No mute delay — audio flows immediately for instant responsiveness
    _audio_mute_until = 0
    # Agent is ALWAYS awake — no wake word needed. Natural conversation from the start.
    _awake = True
    _awake_state[session_id] = True
    _awake_timer: asyncio.TimerHandle | None = None
    _WAKE_TIMEOUT = 86400  # 24h — always awake for demo, no auto-sleep

    # ── Wake word helpers (shared by upstream_reader AND downstream_handler) ──
    def _reset_awake_timer():
        """Reset the auto-sleep timer. After _WAKE_TIMEOUT seconds of no speech, go back to sleep."""
        nonlocal _awake_timer
        if _awake_timer:
            _awake_timer.cancel()
        loop = asyncio.get_event_loop()
        _awake_timer = loop.call_later(_WAKE_TIMEOUT, _go_to_sleep)

    def _go_to_sleep():
        nonlocal _awake
        if _awake:
            _awake = False
            _awake_state[session_id] = False
            print(f"[wake] Auto-sleep after {_WAKE_TIMEOUT}s silence")
            asyncio.ensure_future(_send_wake_state(False))

    async def _send_wake_state(awake_val: bool):
        try:
            await websocket.send_json({"type": "wake", "awake": awake_val})
        except Exception:
            pass

    await websocket.send_json({"type": "status", "state": "idle"})

    # Pre-load the prime into the queue BEFORE run_live starts.
    # The Native Audio model needs content in the queue when run_live begins —
    # starting with an empty queue causes the model to go deaf.
    live_request_queue.send_content(types.Content(parts=[
        types.Part(text="System ready. You are Lobster — greet the user NOW! Say something like 'Hey! Lobster here, what are we doing today?' Be warm, casual, and ready to chat. The user is already listening.")
    ]))
    print("[conductor] Prime pre-loaded into queue (immediate greeting mode)")

    # Diagnostic: periodic status dump + watchdog
    async def status_monitor():
        """Print pipeline health every 10s. Force reconnect if model goes deaf (no events for 60s)."""
        nonlocal _force_reconnect
        try:
            while client_alive:
                await asyncio.sleep(10)
                if not client_alive:
                    break
                ss = _screenshots.get(session_id)
                ss_size = len(ss) if ss else 0
                elems = _element_maps.get(session_id, [])
                lq = _live_queues.get(session_id)
                event_age = time.time() - _last_event_time
                print(f"[STATUS] audio={_audio_packets_sent} ss={_screenshots_stored} "
                      f"events={_events_received} last_evt={event_age:.0f}s ago "
                      f"ss={ss_size}B elems={len(elems)} alive={client_alive}")

                # Keepalive: inject invisible content every ~45s of silence to prevent Gemini server-side timeout
                active_tasks = _executor_active.get(session_id, set())
                if 45 < event_age < 80 and not active_tasks:
                    lq_ka = _live_queues.get(session_id)
                    if lq_ka:
                        try:
                            lq_ka.send_content(types.Content(parts=[
                                types.Part(text="[keepalive — user is still here. If they seem idle, casually ask if they need anything. Stay warm and responsive.]")
                            ]))
                            _last_event_time = time.time()
                            print(f"[keepalive] Injected at {event_age:.0f}s silence")
                        except Exception:
                            pass

                # Watchdog: if no events for 90s and audio is flowing AND no executor running, model session may have timed out
                if event_age > 90 and _audio_packets_sent > 100 and not active_tasks:
                    print(f"[WATCHDOG] No events for {event_age:.0f}s (no active tasks) — Conductor is DEAD. Forcing reconnect.")
                    _force_reconnect = True
                    # Close the current queue to break the run_live generator
                    lq = _live_queues.get(session_id)
                    if lq:
                        try:
                            lq.close()
                        except Exception:
                            pass
        except asyncio.CancelledError:
            pass

    # ── Upstream: Electron → Conductor (audio only) ──────────────

    async def upstream_reader():
        nonlocal client_alive, _audio_packets_sent, _screenshots_stored, _audio_mute_until, _awake
        msg_count = 0
        try:
            while client_alive:
                msg = await websocket.receive()
                msg_count += 1

                # Debug logging for first 10 messages and every 500th
                if msg_count <= 10 or msg_count % 500 == 0:
                    if "bytes" in msg:
                        data = msg["bytes"]
                        hdr = data[0] if len(data) > 0 else -1
                        kind = "audio" if hdr == 0x01 else "screenshot" if hdr == 0x02 else f"hdr={hdr}"
                        print(f"[upstream] msg #{msg_count}: {kind}, {len(data)-1}B (total_audio={_audio_packets_sent}, total_ss={_screenshots_stored})")
                    elif "text" in msg:
                        print(f"[upstream] msg #{msg_count}: text, {msg['text'][:80]}")

                if "bytes" in msg:
                    data = msg["bytes"]
                    if len(data) < 2:
                        continue
                    header = data[0]
                    payload = data[1:]

                    if header == 0x01 and len(payload) > 0:
                        # Audio → ai-coustics enhancement → forward to Conductor
                        # Skip if in post-reconnect or post-handoff mute period
                        now = time.time()
                        if now < _audio_mute_until or now < _audio_mute_until_map.get(session_id, 0):
                            continue
                        _audio_packets_sent += 1
                        enhanced_audio = _enhance_audio_pcm16(payload)
                        live_request_queue.send_realtime(
                            types.Blob(mime_type="audio/pcm;rate=16000", data=enhanced_audio)
                        )
                    elif header == 0x02:
                        # Screenshot → STORE ONLY (Executor reads from _screenshots)
                        if len(payload) > 100:
                            _screenshots_stored += 1
                            _screenshots[session_id] = payload

                elif "text" in msg:
                    data = json.loads(msg["text"])
                    if data.get("type") == "pong":
                        continue
                    if data.get("type") == "text_command":
                        # Text command → DIRECTLY route through master router (bypass unreliable conductor)
                        if not _awake:
                            _awake = True
                            _awake_state[session_id] = True
                            await _send_wake_state(True)
                            print(f"[wake] Auto-activated via text command")
                        _reset_awake_timer()
                        cmd_text = data["text"]
                        print(f"[text-cmd] Direct routing: '{cmd_text[:60]}'")

                        # Strip wake word if present in typed text
                        clean_cmd = _strip_wake_word(cmd_text)
                        if clean_cmd and len(clean_cmd) >= 3:
                            # Route directly — don't rely on conductor calling the tool
                            asyncio.create_task(_master_router(session_id, clean_cmd))
                            # Also tell Conductor so it can confirm to user
                            live_request_queue.send_content(
                                types.Content(parts=[types.Part(text=f"[USER TYPED]: {cmd_text}. Task has been automatically routed. Just say a SHORT confirmation like 'OK' or 'Robię' and STOP.")])
                            )
                        else:
                            # Too short / just wake word — let conductor handle
                            live_request_queue.send_content(
                                types.Content(parts=[types.Part(text=f"[USER TYPED]: {cmd_text}")])
                            )
                        await websocket.send_json({"type": "status", "state": "thinking"})
                    elif data.get("type") == "element_map":
                        task_id_em = data.get("task_id")
                        if task_id_em and task_id_em in _task_result_queues:
                            _task_element_maps[task_id_em] = data.get("elements", [])
                        _element_maps[session_id] = data.get("elements", [])
                    elif data.get("type") == "task_screenshot":
                        # Per-task screenshot → store for the correct executor
                        ts_task_id = data.get("task_id")
                        ts_b64 = data.get("base64", "")
                        if ts_task_id and ts_b64:
                            import base64 as _b64
                            _task_screenshots[ts_task_id] = _b64.b64decode(ts_b64)
                    elif data.get("type") == "action_result":
                        task_id_ar = data.get("task_id")
                        if task_id_ar and task_id_ar in _task_result_queues:
                            await _task_result_queues[task_id_ar].put(data)
                        else:
                            await _result_queues[session_id].put(data)
                    elif data.get("type") == "cron_modify":
                        job_id_mod = data.get("job_id", "")
                        if job_id_mod in _cron_jobs:
                            if "interval" in data:
                                _cron_jobs[job_id_mod]["interval"] = max(10, int(data["interval"]))
                            if "task" in data and data["task"]:
                                _cron_jobs[job_id_mod]["task"] = data["task"]
                            print(f"[cron] Modified job '{job_id_mod}': interval={_cron_jobs[job_id_mod]['interval']}s task='{_cron_jobs[job_id_mod]['task'][:50]}'")
                            await websocket.send_json({
                                "type": "cron_update", "job_id": job_id_mod,
                                "status": "modified",
                                "interval": _cron_jobs[job_id_mod]["interval"],
                                "task": _cron_jobs[job_id_mod]["task"],
                            })

        except WebSocketDisconnect:
            print(f"[upstream] Client disconnected")
            client_alive = False
        except Exception as e:
            print(f"[upstream] Error: {e}")
            client_alive = False
        finally:
            live_request_queue.close()

    # ── Downstream: ADK Conductor events → Electron ──────────────

    async def downstream_handler():
        nonlocal live_request_queue, turn_text, _events_received, _last_event_time, _force_reconnect, _suppress_prime, _audio_mute_until, _awake
        max_retries = 50
        retry_count = 0
        current_session_id = session_id
        input_transcript_buf = ""  # Accumulate input transcription deltas
        # Dedup: track last delegation to prevent model re-delegating same task
        _last_delegation_text = ""
        _last_delegation_time = 0.0

        # _reset_awake_timer, _go_to_sleep, _send_wake_state are defined at
        # websocket_endpoint scope (shared with upstream_reader)

        _last_user_speech = ""  # Track last user speech for voice fallback
        _tool_called_this_turn = False  # Track if conductor called a tool this turn
        _intent_called_this_turn = False  # Per-turn lock: only 1 execute_user_intent per turn
        _last_activate_listening = 0.0  # Rate-limit activate_listening (5s cooldown)
        _last_voice_fallback = 0.0  # COST: Rate-limit voice fallback (10s cooldown)

        while client_alive and retry_count < max_retries:
            print(f"[conductor] Starting run_live() (attempt {retry_count + 1}, session={current_session_id})")
            event_count = 0
            try:
                async for event in runner.run_live(
                    user_id=user_id,
                    session_id=current_session_id,
                    live_request_queue=live_request_queue,
                    run_config=run_config,
                ):
                    if not client_alive:
                        return
                    retry_count = 0
                    event_count += 1
                    _events_received += 1
                    _last_event_time = time.time()

                    # Signal frontend that Gemini Live is active and listening
                    if event_count == 1:
                        try:
                            await websocket.send_json({"type": "live_ready"})
                            print("[conductor] Gemini Live is active — sent live_ready to frontend")
                        except Exception:
                            pass

                    if event_count <= 15 or event_count % 50 == 0:
                        extras = []
                        if hasattr(event, 'input_transcription') and event.input_transcription:
                            extras.append(f"input='{getattr(event.input_transcription, 'text', '')[:40]}'")
                        if hasattr(event, 'output_transcription') and event.output_transcription:
                            extras.append(f"output='{getattr(event.output_transcription, 'text', '')[:40]}'")
                        if hasattr(event, 'turn_complete') and event.turn_complete:
                            extras.append("TURN_COMPLETE")
                        if hasattr(event, 'interrupted') and event.interrupted:
                            extras.append("INTERRUPTED")
                        print(f"[conductor] Event #{event_count}: content={bool(event.content)}, funcs={bool(event.get_function_calls())} {' '.join(extras)}")

                    try:
                        # Clear handoff flag — auto-wake to deliver task results
                        if _handoff_pending.get(session_id):
                            _handoff_pending[session_id] = False
                            _suppress_prime = False  # Critical: allow handoff audio through (suppress_prime blocks ALL audio after reconnect)
                            _audio_mute_until = 0  # Force-open audio gate so conductor can speak immediately
                            _audio_mute_until_map[session_id] = 0  # Also clear per-session mute
                            if not _awake:
                                _awake = True
                                _awake_state[session_id] = True
                                print(f"[wake] Auto-wake for handoff result")
                                await _send_wake_state(True)
                            _reset_awake_timer()

                        # Router tool calls — only activate_listening + execute_user_intent now
                        if event.get_function_calls():
                            for fc in event.get_function_calls():
                                fc_args = dict(fc.args) if fc.args else {}
                                print(f"[conductor] Tool: {fc.name}({json.dumps(fc_args, ensure_ascii=False)[:200]})")

                                # Dedup: skip duplicate execute_user_intent within 10s + per-turn lock
                                if fc.name == "execute_user_intent":
                                    if _intent_called_this_turn:
                                        print(f"[conductor] BLOCKED: duplicate execute_user_intent in same turn")
                                        continue
                                    _intent_called_this_turn = True
                                    _tool_called_this_turn = True
                                    intent_text = fc_args.get("intent", "")
                                    now_dedup = time.time()
                                    if intent_text and intent_text == _last_delegation_text and (now_dedup - _last_delegation_time) < 10:
                                        print(f"[conductor] DEDUP: skipping duplicate intent '{intent_text[:50]}'")
                                        continue
                                    if intent_text:
                                        _last_delegation_text = intent_text
                                        _last_delegation_time = now_dedup

                                if fc.name == "activate_listening":
                                    _now_al = time.time()
                                    if _now_al - _last_activate_listening < 5.0:
                                        continue  # Rate-limit: max 1 per 5s
                                    _last_activate_listening = _now_al
                                    if not _awake:
                                        _awake = True
                                        _awake_state[session_id] = True
                                        print(f"[wake] activate_listening tool called — AWAKE")
                                        await _send_wake_state(True)
                                        _reset_awake_timer()

                        # Router tool results
                        if event.get_function_responses():
                            await websocket.send_json({"type": "status", "state": "thinking"})

                        # Audio output → Electron — ALWAYS forward, no gating
                        if event.content and event.content.parts:
                            for part in event.content.parts:
                                if part.inline_data and part.inline_data.mime_type and part.inline_data.mime_type.startswith("audio/"):
                                    if not _suppress_prime:
                                        await websocket.send_bytes(part.inline_data.data)
                                        await websocket.send_json({"type": "status", "state": "speaking"})

                        # Output transcription → always forward
                        if hasattr(event, 'output_transcription') and event.output_transcription:
                            t = getattr(event.output_transcription, 'text', None)
                            if t:
                                if not turn_text:
                                    input_transcript_buf = ""
                                turn_text = t
                                if not _suppress_prime:
                                    await websocket.send_json({
                                        "type": "transcript", "text": turn_text, "replace": True
                                    })

                        # Input transcription → accumulate deltas, check wake word, forward
                        if hasattr(event, 'input_transcription') and event.input_transcription:
                            t = getattr(event.input_transcription, 'text', None)
                            if t:
                                # Detect repetition: if new delta repeats existing content, replace instead of append
                                stripped = t.strip()
                                if stripped and stripped in input_transcript_buf:
                                    pass  # Skip duplicate transcription chunk
                                else:
                                    input_transcript_buf += t
                                # Track last user speech for voice fallback routing
                                if _awake and input_transcript_buf.strip():
                                    _last_user_speech = input_transcript_buf.strip()
                                await websocket.send_json({"type": "input_transcript", "text": input_transcript_buf})
                                # Wake word detection — fuzzy match (Gemini often mishears "lobster")
                                lower = input_transcript_buf.lower()
                                _wake_phrases = [
                                    "hey lobster", "hej lobster", "hey, lobster", "hej, lobster",
                                    "hello lobster", "hi lobster", "he lobster",
                                    "hey lobstar", "hey lob star", "hey lobs",
                                    "hej lobstar", "hello lob",
                                    "hey, lob", "hey lab", "hay lobster",
                                    # Gemini often mishears as "halo", "ster", "loster" etc.
                                    "halo lobster", "halo lob", "halo ster",
                                    "hej loster", "hey loster", "hey lo",
                                ]
                                # Match "lobster" or common mishearings anywhere
                                _has_wake = (
                                    any(p in lower for p in _wake_phrases)
                                    or "lobster" in lower or "lobstar" in lower
                                    or "loster" in lower or "lobste" in lower
                                )
                                if not _awake and _has_wake:
                                    _awake = True
                                    _awake_state[session_id] = True
                                    print(f"[wake] WAKE WORD detected: '{input_transcript_buf[:60]}'")
                                    await _send_wake_state(True)
                                    _reset_awake_timer()
                                elif _awake:
                                    # Reset auto-sleep timer on any speech while awake
                                    _reset_awake_timer()

                        # Turn complete → reset + stop suppressing prime
                        if hasattr(event, 'turn_complete') and event.turn_complete:
                            was_prime = _suppress_prime
                            print(f"[conductor] Turn complete. Said: {turn_text[:100]}{' (PRIME)' if was_prime else ''} awake={_awake} tool_called={_tool_called_this_turn}")
                            # Track conversation history for reconnect context
                            if not was_prime:
                                if _last_user_speech:
                                    _append_conversation(session_id, "user", _last_user_speech)
                                if turn_text:
                                    _append_conversation(session_id, "agent", turn_text)

                            # VOICE FALLBACK: If conductor spoke but DIDN'T call execute_user_intent,
                            # route the user's last speech directly through the master router.
                            # This prevents the "says Jasne but does nothing" bug.
                            if _awake and not was_prime and not _tool_called_this_turn and _last_user_speech:
                                clean_speech = _strip_wake_word(_last_user_speech)
                                # Validate: must be long enough, have 2+ words, AND contain Latin/Polish characters
                                # Single words / echo fragments should NOT become tasks
                                _is_latin = bool(re.search(r'[a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ]{3,}', clean_speech))
                                _word_count = len(clean_speech.split())
                                if clean_speech and len(clean_speech) >= 12 and _word_count >= 3 and _is_latin:
                                    # Check it's not a conversation / reaction / garbage
                                    _lower_speech = clean_speech.lower()
                                    _is_garbage = _last_user_speech.lower().startswith("task done") or any(
                                        _lower_speech.startswith(gp) for gp in [
                                            "hey, love", "love star", "no, ale", "żeby się",
                                            "you're a", "i'm a", "that's a", "just a",
                                            "that's not", "that is not", "it's not", "it is not",
                                            "no that's", "no it's", "no, that", "no, it",
                                            "what the", "wait what", "oh my", "oh no",
                                            "słucham", "jasne", "okej", "no to", "gotowe",
                                            "zrobione", "rozumiem", "dobra", "spoko",
                                            "nie prawda", "nie, to nie", "to nie", "ale nie",
                                            "co ty", "co to", "ale co", "no nie",
                                            "yeah right", "come on", "oh well", "all right",
                                            "that didn't", "it didn't", "you didn't",
                                            "this is", "why did", "how did", "what did",
                                            "nie działa", "nie wysłał", "nie zrobił",
                                        ]
                                    )
                                    # Detect CONVERSATIONAL phrases (no action verbs)
                                    _ACTION_VERBS = {"open", "go", "search", "find", "send", "write", "draw",
                                                     "create", "make", "navigate", "click", "show", "play",
                                                     "otwórz", "szukaj", "znajdź", "wyślij", "napisz", "narysuj",
                                                     "stwórz", "zrób", "idź", "pokaż", "odtwórz", "wejdź"}
                                    _words_vf = [w.strip('.,!?') for w in _lower_speech.split()]
                                    if not any(w in _ACTION_VERBS for w in _words_vf):
                                        _is_garbage = True  # No action verb = conversation, not a command
                                    # Detect repeated words (echoes): "siema siema siema"
                                    _unique_vf = set(_words_vf)
                                    if len(_unique_vf) <= 2:
                                        _is_garbage = True
                                    # Detect pure greetings
                                    _GREETINGS = {"siema", "hej", "cześć", "czesc", "hello", "hi", "hey", "yo", "hola", "witam", "elo", "hejka", "siemka"}
                                    if all(w in _GREETINGS for w in _words_vf if w):
                                        _is_garbage = True
                                    if not _is_garbage:
                                        # Rate-limit voice fallback — max 1 per 3s (natural conversation pace)
                                        _now_vf = time.time()
                                        if _now_vf - _last_voice_fallback < 3.0:
                                            print(f"[voice-fallback] Cooldown ({_now_vf - _last_voice_fallback:.1f}s since last) — skipping: '{clean_speech[:40]}'")
                                        else:
                                            _last_voice_fallback = _now_vf
                                            print(f"[voice-fallback] Conductor didn't call tool. Auto-routing: '{clean_speech[:60]}'")
                                            asyncio.create_task(_master_router(session_id, clean_speech))
                                    else:
                                        print(f"[voice-fallback] Skipping handoff response")
                                else:
                                    print(f"[voice-fallback] Skipping non-Latin/too-short: '{clean_speech[:40]}'")


                            turn_text = ""
                            input_transcript_buf = ""  # Reset input buffer for next turn
                            _last_user_speech = ""  # Reset for next turn
                            _tool_called_this_turn = False  # Reset for next turn
                            _intent_called_this_turn = False  # Reset per-turn intent lock
                            _suppress_prime = False  # After first turn, ALL audio flows freely
                            _delegations_this_turn[session_id] = 0
                            await websocket.send_json({"type": "status", "state": "idle"})
                            # Reset awake timer — user may continue conversation
                            if _awake:
                                _reset_awake_timer()

                        # Interrupted → reset
                        if hasattr(event, 'interrupted') and event.interrupted:
                            turn_text = ""
                            input_transcript_buf = ""
                            await websocket.send_json({"type": "status", "state": "listening"})

                        # Errors
                        if hasattr(event, 'error_code') and event.error_code:
                            await websocket.send_json({
                                "type": "error",
                                "message": f"{event.error_code}: {getattr(event, 'error_message', '')}",
                            })

                    except Exception as e:
                        print(f"[conductor] Event error: {e}")

            except Exception as e:
                err_msg = str(e)[:80]
                was_watchdog = _force_reconnect
                if was_watchdog:
                    _force_reconnect = False
                    print(f"[conductor] WATCHDOG reconnect triggered")
                else:
                    retry_count += 1
                    print(f"[conductor] Connection dropped ({err_msg}). Reconnecting {retry_count}/{max_retries}...")
                if not client_alive:
                    return
                # Fresh session + queue
                live_request_queue = LiveRequestQueue()
                _live_queues[session_id] = live_request_queue
                current_session_id = f"{session_id}_r{int(time.time())}"
                await session_service.create_session(
                    app_name=APP_NAME, user_id=user_id,
                    session_id=current_session_id,
                    state={"_session_id": session_id},
                )
                _last_event_time = time.time()  # Reset watchdog timer
                # Mute user audio until re-prime is sent + model processes it
                # Prevents stray audio noise from causing empty turn before re-prime arrives
                _audio_mute_until = time.time() + 0.8  # Short mute — reconnect stabilization only
                _suppress_prime = False  # Let the greeting through — agent speaks freely now
                _delegations_this_turn[session_id] = 0
                # Only clear non-cron active tasks on reconnect (preserve running cron jobs)
                active = _executor_active.get(session_id, set())
                cron_tasks = {t for t in active if t.startswith("cron_")}
                _executor_active[session_id] = cron_tasks
                print(f"[conductor] Fresh session: {current_session_id} (preserved {len(cron_tasks)} cron tasks)")
                turn_text = ""
                await asyncio.sleep(0.5)  # Minimal wait — just enough for session to stabilize
                # Re-prime after reconnect — include conversation history for context
                try:
                    history = _conversation_history.get(session_id, [])
                    history_text = ""
                    if history:
                        turns = []
                        for h in history[-10:]:
                            speaker = "User" if h["role"] == "user" else "You (Lobster)"
                            turns.append(f"  {speaker}: {h['text'][:150]}")
                        history_text = "\n\nCONVERSATION SO FAR:\n" + "\n".join(turns) + "\n"
                    live_request_queue.send_content(types.Content(parts=[
                        types.Part(text=f"Session resumed after brief disconnect. You are Lobster.{history_text}\nContinue naturally — say 'I'm back!' or similar brief acknowledgment, then stay ready and responsive.")
                    ]))
                    print(f"[conductor] Re-primed after reconnect with {len(history)} history turns")
                except Exception:
                    pass
                try:
                    await websocket.send_json({"type": "status", "state": "idle"})
                except Exception:
                    return

        if retry_count >= max_retries:
            print(f"[conductor] Max retries ({max_retries}) reached. Giving up.")

    # ── Keepalive ────────────────────────────────────────────────

    async def keepalive():
        try:
            while client_alive:
                await asyncio.sleep(15)
                if not client_alive:
                    break
                try:
                    await websocket.send_json({"type": "ping"})
                except Exception:
                    break
        except asyncio.CancelledError:
            pass

    # ── Run all tasks ────────────────────────────────────────────

    try:
        upstream = asyncio.create_task(upstream_reader())
        downstream = asyncio.create_task(downstream_handler())
        pinger = asyncio.create_task(keepalive())
        monitor = asyncio.create_task(status_monitor())

        done, pending = await asyncio.wait(
            [upstream, downstream],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for t in [*pending, pinger, monitor]:
            t.cancel()
        # Cancel any running executors
        task_dict = _executor_tasks.pop(session_id, {})
        for tid, ex in task_dict.items():
            if ex and not ex.done():
                ex.cancel()
        await asyncio.gather(upstream, downstream, pinger, return_exceptions=True)

    except Exception as e:
        print(f"[session] Fatal error: {e}")
        traceback.print_exc()
    finally:
        # Cancel all cron jobs for this session
        for jid, job in list(_cron_jobs.items()):
            if job["session_id"] == session_id:
                t = job.get("asyncio_task")
                if t and not t.done():
                    t.cancel()
                _cron_jobs.pop(jid, None)
                print(f"[cron] Cleaned up job '{jid}' on disconnect")

        _action_queues.pop(session_id, None)
        _result_queues.pop(session_id, None)
        _websockets.pop(session_id, None)
        _screenshots.pop(session_id, None)
        _element_maps.pop(session_id, None)
        _live_queues.pop(session_id, None)
        _last_transcript.pop(session_id, None)
        _executor_tasks.pop(session_id, None)
        _handoff_pending.pop(session_id, None)
        _executor_active.pop(session_id, None)
        _delegations_this_turn.pop(session_id, None)
        _awake_state.pop(session_id, None)
        _conversation_history.pop(session_id, None)
        print(f"[session] Session ended for {user_id}/{session_id}")
        try:
            await websocket.close()
        except Exception:
            pass


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port)
