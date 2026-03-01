"""Advanced browser skills: JS eval, cookie dismiss, form filling."""

from google.adk.tools import ToolContext
from ._base import _send_action_and_wait


async def evaluate_javascript(tool_context: ToolContext, code: str) -> dict:
    """Execute custom JavaScript code on the page and return the result. Use as escape hatch for interactions not covered by other tools. Return value is stringified."""
    return await _send_action_and_wait(tool_context, {"action": "evaluate", "code": code})


async def dismiss_cookies(tool_context: ToolContext) -> dict:
    """Automatically dismiss any cookie consent banner on the current page."""
    return await _send_action_and_wait(tool_context, {"action": "dismiss-cookies"})


async def fill_complex_form(tool_context: ToolContext, fields: list[dict]) -> dict:
    """Fill multiple form fields at once. Each field: {"label": "Field label text", "value": "value to fill"}.
    Matches fields by label text, placeholder, name, or aria-label. Much faster than clicking + typing each field individually."""

    # Generate JS that finds and fills each field
    field_json = str(fields).replace("'", '"')
    js = f"""
    (function() {{
        var fields = {field_json};
        var results = [];
        fields.forEach(function(f) {{
            var label = f.label.toLowerCase();
            var value = f.value;
            var found = false;

            // Strategy 1: Find by label element
            document.querySelectorAll('label').forEach(function(lbl) {{
                if (found) return;
                if (lbl.textContent.toLowerCase().trim().includes(label)) {{
                    var input = lbl.querySelector('input, textarea, select');
                    if (!input && lbl.htmlFor) {{
                        input = document.getElementById(lbl.htmlFor);
                    }}
                    if (input) {{
                        var nativeSet = Object.getOwnPropertyDescriptor(
                            window.HTMLInputElement.prototype, 'value'
                        );
                        if (nativeSet && nativeSet.set) nativeSet.set.call(input, value);
                        else input.value = value;
                        input.dispatchEvent(new Event('input', {{bubbles: true}}));
                        input.dispatchEvent(new Event('change', {{bubbles: true}}));
                        found = true;
                        results.push({{label: f.label, status: 'filled'}});
                    }}
                }}
            }});

            // Strategy 2: Find by placeholder/name/aria-label
            if (!found) {{
                var inputs = document.querySelectorAll('input, textarea, select');
                inputs.forEach(function(inp) {{
                    if (found) return;
                    var ph = (inp.placeholder || '').toLowerCase();
                    var nm = (inp.name || '').toLowerCase();
                    var al = (inp.getAttribute('aria-label') || '').toLowerCase();
                    if (ph.includes(label) || nm.includes(label) || al.includes(label)) {{
                        var nativeSet = Object.getOwnPropertyDescriptor(
                            window.HTMLInputElement.prototype, 'value'
                        );
                        if (nativeSet && nativeSet.set) nativeSet.set.call(inp, value);
                        else inp.value = value;
                        inp.dispatchEvent(new Event('input', {{bubbles: true}}));
                        inp.dispatchEvent(new Event('change', {{bubbles: true}}));
                        found = true;
                        results.push({{label: f.label, status: 'filled'}});
                    }}
                }});
            }}

            if (!found) results.push({{label: f.label, status: 'not_found'}});
        }});
        return JSON.stringify(results);
    }})()
    """
    return await _send_action_and_wait(tool_context, {"action": "evaluate", "code": js})
