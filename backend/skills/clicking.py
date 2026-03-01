"""Clicking skills: element interaction via text, ref ID, or coordinates."""

from google.adk.tools import ToolContext
from ._base import _send_action_and_wait


async def click_element(tool_context: ToolContext, x: int, y: int, description: str = "") -> dict:
    """Click at x,y coordinates on the 768x768 screenshot grid. WARNING: This is INACCURATE. Prefer click_element_by_text() or click_element_ref() instead."""
    return await _send_action_and_wait(tool_context, {
        "action": "click", "x": x, "y": y, "selector": description,
    })


async def click_element_ref(tool_context: ToolContext, ref: int, description: str = "") -> dict:
    """Click an element by its # number from the [PAGE ELEMENTS] list. Very precise — use the number shown next to the element."""
    return await _send_action_and_wait(tool_context, {
        "action": "click-by-ref", "ref": ref, "description": description,
    })


async def click_element_by_text(tool_context: ToolContext, text: str) -> dict:
    """Click on ANY element by its visible text. MOST RELIABLE click method — use this for search results, links, buttons, menu items. Pass the exact visible text you see in the element list. Case-insensitive partial match."""
    return await _send_action_and_wait(tool_context, {"action": "click-by-text", "text": text})
