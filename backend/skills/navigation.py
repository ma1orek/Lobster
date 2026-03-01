"""Navigation skills: URL navigation, browser history, web search."""

import asyncio
from google.adk.tools import ToolContext
from ._base import _send_action_and_wait


async def navigate_to(tool_context: ToolContext, url: str) -> dict:
    """Navigate the browser to a URL. Use this when the user asks to open a website."""
    if url and not url.startswith("http"):
        url = f"https://{url}"
    return await _send_action_and_wait(tool_context, {"action": "navigate", "url": url})


async def go_back(tool_context: ToolContext) -> dict:
    """Navigate back to the previous page."""
    return await _send_action_and_wait(tool_context, {"action": "back"})


async def go_forward(tool_context: ToolContext) -> dict:
    """Navigate forward in browser history (opposite of go_back)."""
    return await _send_action_and_wait(tool_context, {"action": "forward"})


async def search_web(tool_context: ToolContext, query: str) -> dict:
    """Search the web using Google. After searching, WAIT for the [PAGE ELEMENTS] list, then use click_element_by_text() to click the correct search result. Do NOT guess coordinates."""
    url = f"https://www.google.com/search?q={query.replace(' ', '+')}"
    result = await _send_action_and_wait(tool_context, {"action": "navigate", "url": url})
    await asyncio.sleep(1.5)
    return result
