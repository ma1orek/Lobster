"""Advanced interaction skills: drag, hover, double-click, wait."""

from google.adk.tools import ToolContext
from ._base import _send_action_and_wait


async def mouse_drag(tool_context: ToolContext, from_x: int, from_y: int, to_x: int, to_y: int, description: str = "") -> dict:
    """Click and drag the mouse from one point to another. Use this for drawing, moving objects, resizing, slider adjustments, etc. Coordinates are on a 768x768 grid matching the screenshot."""
    return await _send_action_and_wait(tool_context, {
        "action": "drag",
        "from_x": from_x, "from_y": from_y,
        "to_x": to_x, "to_y": to_y,
        "description": description,
    })


async def mouse_drag_path(tool_context: ToolContext, points: list[dict], description: str = "") -> dict:
    """Draw a complex path by dragging through multiple points. Use this for drawing shapes like hearts, circles, letters. Coordinates are on a 768x768 grid. Points should be close together for smooth lines."""
    return await _send_action_and_wait(tool_context, {
        "action": "drag-path", "points": points, "description": description,
    })


async def hover_element(tool_context: ToolContext, x: int, y: int, description: str = "") -> dict:
    """Move mouse over an element without clicking — triggers hover menus, tooltips, dropdown reveals. Coordinates on 768x768 grid."""
    return await _send_action_and_wait(tool_context, {
        "action": "hover", "x": x, "y": y, "description": description,
    })


async def double_click(tool_context: ToolContext, x: int, y: int, description: str = "") -> dict:
    """Double-click at coordinates. Use for: selecting words in text, opening items, activating edit mode in cells/forms."""
    return await _send_action_and_wait(tool_context, {
        "action": "double-click", "x": x, "y": y, "description": description,
    })


async def wait_for(tool_context: ToolContext, condition: str, text: str = "", pattern: str = "", milliseconds: int = 1000) -> dict:
    """Wait for a condition before proceeding. Use when page is loading, content hasn't appeared yet, or you need to pause."""
    return await _send_action_and_wait(tool_context, {
        "action": "wait", "condition": condition, "text": text,
        "pattern": pattern, "milliseconds": min(milliseconds, 10000),
    }, timeout=min(milliseconds / 1000 + 2, 12))
