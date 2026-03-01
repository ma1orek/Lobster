"""Input skills: typing, keyboard, dropdowns."""

from google.adk.tools import ToolContext
from ._base import _send_action_and_wait


async def type_text(tool_context: ToolContext, text: str) -> dict:
    """Type text into the currently focused input field on the page."""
    return await _send_action_and_wait(tool_context, {"action": "type", "text": text})


async def press_enter(tool_context: ToolContext) -> dict:
    """Press the Enter key to submit a form or search query."""
    return await _send_action_and_wait(tool_context, {"action": "enter"})


async def press_key(tool_context: ToolContext, key: str, ctrl: bool = False, shift: bool = False, alt: bool = False) -> dict:
    """Press a keyboard key or combination. Use for Tab, Escape, Backspace, Delete, arrow keys, Ctrl+A (select all), Ctrl+C (copy), Ctrl+V (paste), Ctrl+Z (undo), Space, and any other key."""
    return await _send_action_and_wait(tool_context, {
        "action": "press-key", "key": key, "ctrl": ctrl, "shift": shift, "alt": alt,
    })


async def select_dropdown(tool_context: ToolContext, value: str) -> dict:
    """Select an option from a <select> dropdown by its visible text."""
    return await _send_action_and_wait(tool_context, {"action": "select-option", "value": value})
