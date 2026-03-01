"""Tab management skills: open, close, switch tabs."""

from google.adk.tools import ToolContext
from ._base import _send_action_and_wait


async def open_new_tab(tool_context: ToolContext, url: str = "") -> dict:
    """Open a new browser tab, optionally with a URL."""
    return await _send_action_and_wait(tool_context, {"action": "new_tab", "url": url})


async def close_current_tab(tool_context: ToolContext) -> dict:
    """Close the currently active browser tab."""
    return await _send_action_and_wait(tool_context, {"action": "close_tab"})


async def switch_to_tab(tool_context: ToolContext, tab_number: int) -> dict:
    """Switch to a different browser tab by its number (1-indexed from left)."""
    return await _send_action_and_wait(tool_context, {"action": "switch-tab", "tab_number": tab_number})
