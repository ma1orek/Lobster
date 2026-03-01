"""Clipboard skills: copy/read clipboard for cross-tab data transfer."""

from google.adk.tools import ToolContext
from ._base import _send_action_and_wait


async def copy_to_clipboard(tool_context: ToolContext, text: str) -> dict:
    """Copy text to the system clipboard. Use this to transfer data between tabs or to the user."""
    return await _send_action_and_wait(tool_context, {"action": "copy-to-clipboard", "text": text})


async def read_from_clipboard(tool_context: ToolContext) -> dict:
    """Read text from the system clipboard."""
    return await _send_action_and_wait(tool_context, {"action": "read-clipboard"})
