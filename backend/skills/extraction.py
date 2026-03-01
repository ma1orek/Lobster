"""Extraction skills: page text, structure, markdown reader."""

from google.adk.tools import ToolContext
from ._base import _send_action_and_wait


async def extract_page_text(tool_context: ToolContext) -> dict:
    """Extract readable text content from the current page."""
    return await _send_action_and_wait(tool_context, {"action": "extract-text"})


async def get_page_structure(tool_context: ToolContext) -> dict:
    """Get a list of all interactive elements on the page (buttons, links, inputs) with their text labels and coordinates. Use this to understand what you can click on."""
    return await _send_action_and_wait(tool_context, {"action": "get-page-snapshot"})


async def read_page_as_markdown(tool_context: ToolContext, max_chars: int = 8000) -> dict:
    """Extract page content as clean readable markdown. Strips ads, nav, sidebars — returns only the main content. Use for reading articles, documentation, search results, or any page where you need the actual text content."""
    js = f"""
    (function() {{
        // Remove noise elements
        var noise = document.querySelectorAll('nav, header, footer, aside, [role="banner"], [role="navigation"], [role="complementary"], .sidebar, .nav, .footer, .header, .menu, .ad, .ads, .cookie, script, style, noscript, svg');
        var removed = [];
        noise.forEach(function(el) {{ removed.push(el); }});

        // Find main content
        var main = document.querySelector('main, article, [role="main"], .post-content, .article-body, .entry-content, #content, .content');
        var target = main || document.body;

        // Convert to readable text with structure
        function toMarkdown(el, depth) {{
            if (!el || el.nodeType === 8) return '';
            if (el.nodeType === 3) return el.textContent;

            var tag = el.tagName ? el.tagName.toLowerCase() : '';
            if (['script','style','noscript','nav','footer','svg','iframe'].includes(tag)) return '';

            var text = '';
            for (var c of el.childNodes) {{ text += toMarkdown(c, depth + 1); }}
            text = text.trim();
            if (!text) return '';

            if (tag === 'h1') return '\\n# ' + text + '\\n';
            if (tag === 'h2') return '\\n## ' + text + '\\n';
            if (tag === 'h3') return '\\n### ' + text + '\\n';
            if (tag === 'h4') return '\\n#### ' + text + '\\n';
            if (tag === 'p') return '\\n' + text + '\\n';
            if (tag === 'li') return '- ' + text + '\\n';
            if (tag === 'a') {{
                var href = el.getAttribute('href') || '';
                if (href && !href.startsWith('javascript:') && !href.startsWith('#'))
                    return '[' + text + '](' + href + ')';
                return text;
            }}
            if (tag === 'strong' || tag === 'b') return '**' + text + '**';
            if (tag === 'em' || tag === 'i') return '*' + text + '*';
            if (tag === 'code') return '`' + text + '`';
            if (tag === 'pre') return '\\n```\\n' + text + '\\n```\\n';
            if (tag === 'br') return '\\n';
            if (tag === 'blockquote') return '\\n> ' + text.replace(/\\n/g, '\\n> ') + '\\n';
            return text + (tag === 'div' || tag === 'section' ? '\\n' : ' ');
        }}

        var md = toMarkdown(target, 0);
        // Clean up whitespace
        md = md.replace(/\\n{{3,}}/g, '\\n\\n').trim();
        return md.substring(0, {max_chars});
    }})()
    """
    return await _send_action_and_wait(tool_context, {"action": "evaluate", "code": js})
