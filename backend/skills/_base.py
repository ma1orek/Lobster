"""Shared infrastructure for all Lobster skills.

All per-session state dicts and the core _send_action_and_wait helper live here.
Skills import from this module to send actions to Electron and receive results.
"""

import asyncio
from google.adk.tools import ToolContext

# ── Per-session shared state ──
_action_queues: dict[str, asyncio.Queue] = {}
_result_queues: dict[str, asyncio.Queue] = {}
_screenshots: dict[str, bytes] = {}
_element_maps: dict[str, list[dict]] = {}
_websockets: dict[str, object] = {}  # WebSocket instances
_live_queues: dict[str, object] = {}  # LiveRequestQueue instances
_last_transcript: dict[str, tuple[str, float]] = {}


def _format_element_map_for_model(elements: list[dict]) -> str:
    """Format element map as concise text for the audio model."""
    if not elements:
        return ""
    lines = ["[PAGE ELEMENTS — use click_element_by_text(text) or click_element_ref(ref) to click these]"]
    for e in elements[:80]:
        ref_id = e.get('id', '?')
        tag = e.get('tag', '?')
        role = e.get('role', tag)
        label = e.get('label', '').strip()
        title = e.get('title', '').strip()
        name_attr = e.get('name', '').strip()
        section = e.get('section', '').strip()
        href = e.get('href', '')
        el_type = e.get('type', '')

        parts = [f"#{ref_id}"]
        if role in ('a', 'link'):
            parts.append('LINK')
        elif role in ('button',) or tag == 'button':
            parts.append('BTN')
        elif tag in ('input', 'textarea', 'select'):
            parts.append(f'INPUT[{el_type}]' if el_type else tag.upper())
        else:
            parts.append(role.upper())

        if label:
            parts.append(f'"{label}"')
        elif title:
            parts.append(f'title="{title}"')
        if name_attr and tag in ('input', 'textarea', 'select'):
            parts.append(f'name={name_attr}')
        if section:
            parts.append(f'in:{section}')
        if href and not href.startswith('javascript:'):
            short_href = href[:60] + ('…' if len(href) > 60 else '')
            parts.append(f'→ {short_href}')

        lines.append(' '.join(parts))

    lines.append("[Use click_element_by_text('exact visible text') for links/buttons — MOST RELIABLE]")
    lines.append("[Use click_element_ref(number) with the # number — PRECISE]")
    lines.append("[AVOID click_element(x,y) coordinates — INACCURATE]")
    lines.append("[Tip: For icon-only buttons check title. For forms use name attribute.]")
    return '\n'.join(lines)


async def _send_action_and_wait(tool_context: ToolContext, action: dict, timeout: float = 5.0) -> dict:
    """Send an action to Electron and wait for the result."""
    sid = tool_context.state.get("_session_id", "default")
    q_result = _result_queues.get(sid)
    ws = _websockets.get(sid)

    if ws:
        try:
            await ws.send_json({"type": "action", **action})
        except Exception:
            return {"status": "error", "message": "WebSocket send failed"}
    else:
        q_action = _action_queues.get(sid)
        if q_action:
            await q_action.put(action)

    if q_result:
        try:
            result = await asyncio.wait_for(q_result.get(), timeout=timeout)
            result["_verify"] = "Check screenshot to confirm this action succeeded."
            elems = _element_maps.get(sid, [])
            if elems:
                result["_page_elements"] = _format_element_map_for_model(elems)
            return result
        except asyncio.TimeoutError:
            return {"status": "error", "message": f"Action timed out after {timeout}s"}

    return {"status": "error", "message": "No result queue available"}
