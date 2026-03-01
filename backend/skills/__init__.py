"""Lobster Browser Skills — modular tool system for ADK agent.

Import ALL_SKILLS to register all tools with the ADK agent.
"""

from .navigation import navigate_to, go_back, go_forward, search_web
from .clicking import click_element, click_element_ref, click_element_by_text
from .input import type_text, press_enter, press_key, select_dropdown
from .scrolling import scroll_page, scroll_to_text
from .tabs import open_new_tab, close_current_tab, switch_to_tab
from .extraction import extract_page_text, get_page_structure, read_page_as_markdown
from .interaction import mouse_drag, mouse_drag_path, hover_element, double_click, wait_for
from .vision import vision_act
from .advanced_browser import evaluate_javascript, dismiss_cookies, fill_complex_form
from .creative import generate_diagram, draw_with_cursor
from .clipboard import copy_to_clipboard, read_from_clipboard

ALL_SKILLS = [
    # Navigation
    navigate_to, go_back, go_forward, search_web,
    # Clicking (priority order: by_text > by_ref > coordinates)
    click_element_by_text, click_element_ref, click_element,
    # Input
    type_text, press_enter, press_key, select_dropdown,
    # Scrolling
    scroll_page, scroll_to_text,
    # Tabs
    open_new_tab, close_current_tab, switch_to_tab,
    # Extraction
    extract_page_text, get_page_structure, read_page_as_markdown,
    # Advanced interaction
    mouse_drag, mouse_drag_path, hover_element, double_click, wait_for,
    # Vision
    vision_act,
    # Advanced browser
    evaluate_javascript, dismiss_cookies, fill_complex_form,
    # Creative
    generate_diagram, draw_with_cursor,
    # Clipboard
    copy_to_clipboard, read_from_clipboard,
]
