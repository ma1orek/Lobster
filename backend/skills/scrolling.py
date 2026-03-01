"""Scrolling skills: page scroll, scroll to text."""

from google.adk.tools import ToolContext
from ._base import _send_action_and_wait


async def scroll_page(tool_context: ToolContext, direction: str, amount: int = 500) -> dict:
    """Scroll the page up or down."""
    return await _send_action_and_wait(tool_context, {
        "action": "scroll", "direction": direction, "amount": amount,
    })


async def scroll_to_text(tool_context: ToolContext, text: str) -> dict:
    """Find text on the page and scroll it into view. Use when you need to find something not currently visible."""
    return await _send_action_and_wait(tool_context, {"action": "scroll-to-text", "text": text})
