"""Vision skills: delegate complex visual tasks to Gemini vision model."""

import os
import json
import asyncio
from google.genai import types
from google.adk.tools import ToolContext
from ._base import _send_action_and_wait, _screenshots, _element_maps, _websockets, _live_queues

VISION_MODEL = "gemini-3-flash-preview"


async def vision_act(tool_context: ToolContext, task: str) -> dict:
    """Delegate a complex visual task to the vision brain. It analyzes the current screenshot and performs multi-step interactions autonomously. Use for: complex UI tasks, when multiple precise clicks are needed, or when you need detailed visual understanding."""
    sid = tool_context.state.get("_session_id", "default")
    screenshot = _screenshots.get(sid)

    print(f"[vision-act] Starting: {task[:60]}")

    if screenshot:
        elements = list(_element_maps.get(sid, []))
        asyncio.create_task(_vision_background(sid, task, bytes(screenshot), elements))

    return {
        "status": "started_in_background",
        "message": f"Vision brain is working on: {task}. Continue talking — you'll be notified when done.",
    }


async def vision_analyze(screenshot_bytes: bytes, task: str, element_map: list[dict] | None = None) -> list[dict]:
    """Use Gemini vision model to analyze a screenshot and return browser actions."""
    from google import genai as genai_client

    api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
    if not api_key:
        return []

    client = genai_client.Client(api_key=api_key)

    elem_context = ""
    if element_map:
        elem_lines = []
        for e in element_map[:50]:
            elem_lines.append(f"  #{e['id']}: {e.get('tag','?')}[{e.get('role','')}] \"{e.get('label','')}\" at ({e.get('x',0)},{e.get('y',0)})")
        elem_context = "\n\nINTERACTIVE ELEMENTS (with IDs and positions on 768x768 grid):\n" + "\n".join(elem_lines) + "\n\nUse click-by-ref with element IDs for precise clicking."

    try:
        response = await client.aio.models.generate_content(
            model=VISION_MODEL,
            contents=[
                types.Content(role="user", parts=[
                    types.Part(inline_data=types.Blob(mime_type="image/jpeg", data=screenshot_bytes)),
                    types.Part(text=f"""You are Lobster, a browser automation agent. Analyze the screenshot and perform the task.

TASK: {task}
{elem_context}

Return a JSON array of actions:
- {{"action": "click-by-ref", "ref": <element_id>, "description": "<what>"}}
- {{"action": "click", "x": <int>, "y": <int>, "description": "<what>"}}
- {{"action": "type", "text": "<text>"}}
- {{"action": "enter"}}
- {{"action": "scroll", "direction": "up"|"down", "amount": <pixels>}}
- {{"action": "navigate", "url": "<url>"}}
- {{"action": "press-key", "key": "<key>", "ctrl": false, "shift": false}}
- {{"action": "dismiss-cookies"}}
- {{"action": "back"}}

RULES:
- Match elements in the screenshot to the element map IDs
- Use "click-by-ref" with element IDs when available — most accurate
- If there's a popup/modal/cookie banner, dismiss it FIRST
- Return ONLY the JSON array, no markdown
- If the task is already done, return []"""),
                ]),
            ],
            config=types.GenerateContentConfig(
                temperature=0.1,
                max_output_tokens=1024,
            ),
        )

        text = response.text.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            text = text.rsplit("```", 1)[0].strip()
        if text.startswith("json"):
            text = text[4:].strip()

        actions = json.loads(text)
        if isinstance(actions, list):
            print(f"[vision-brain] Got {len(actions)} actions for task: {task[:60]}")
            return actions
        return []
    except Exception as e:
        print(f"[vision-brain] Error: {e}")
        return []


async def _vision_background(sid: str, task: str, screenshot: bytes, elements: list):
    """Background task: vision brain analyzes + executes actions."""
    try:
        actions = await vision_analyze(screenshot, task, elements)
        ws = _websockets.get(sid)
        executed = 0

        for va in actions:
            if not va.get("action"):
                continue
            try:
                if ws:
                    await ws.send_json({"type": "action", **va})
            except Exception:
                break
            executed += 1
            await asyncio.sleep(0.5)

        await asyncio.sleep(0.8)

        summary = f"[VISION_RESULT] Completed {executed} actions for: {task}. Verify on screenshot."
        lrq = _live_queues.get(sid)
        if lrq:
            try:
                lrq.send_content(types.Content(
                    parts=[types.Part(text=summary)]
                ))
                fresh = _screenshots.get(sid)
                if fresh:
                    lrq.send_realtime(types.Blob(mime_type="image/jpeg", data=fresh))
            except Exception as e:
                print(f"[vision-bg] Notify error: {e}")

        print(f"[vision-bg] Done: {executed} actions for '{task[:60]}'")
    except Exception as e:
        print(f"[vision-bg] Error: {e}")
