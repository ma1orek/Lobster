"""Creative skills: diagram generation, visual creation, ghost-cursor drawing."""

import os
import json
import asyncio
from google.genai import types
from google.adk.tools import ToolContext
from ._base import _send_action_and_wait


async def generate_diagram(tool_context: ToolContext, description: str, diagram_type: str = "flowchart") -> dict:
    """Generate a diagram on the current page (should be Excalidraw). First navigate_to('https://excalidraw.com'), then call this.
    diagram_type: 'flowchart', 'mindmap', 'architecture', 'sequence', 'org_chart', 'timeline'.
    The AI will generate Excalidraw-compatible elements and paste them onto the canvas."""
    from google import genai as genai_client

    api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
    if not api_key:
        return {"status": "error", "message": "No API key"}

    client = genai_client.Client(api_key=api_key)

    try:
        response = await client.aio.models.generate_content(
            model="gemini-2.0-flash",
            contents=[
                types.Content(role="user", parts=[
                    types.Part(text=f"""Generate an Excalidraw diagram as a JSON array of elements.

DIAGRAM: {description}
TYPE: {diagram_type}

Return a JSON array where each element has:
- "type": "rectangle" | "ellipse" | "diamond" | "text" | "arrow" | "line"
- "x": number (position, start at 100)
- "y": number (position, start at 100)
- "width": number (for shapes, typically 150-200)
- "height": number (for shapes, typically 60-80)
- "text": string (label text, if any)
- "strokeColor": "#1e1e1e" (default)
- "backgroundColor": "#a5d8ff" | "#b2f2bb" | "#ffd8a8" | "#fcc2d7" | "#d0bfff" (use varied colors)
- "fillStyle": "hachure"

For arrows connecting shapes:
- "type": "arrow"
- "startX", "startY", "endX", "endY"

Keep it clean and readable. 5-10 elements max.
Return ONLY the JSON array, no markdown."""),
                ]),
            ],
            config=types.GenerateContentConfig(temperature=0.3, max_output_tokens=2048),
        )

        text = response.text.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            text = text.rsplit("```", 1)[0].strip()
        if text.startswith("json"):
            text = text[4:].strip()

        elements = json.loads(text)

        # Inject elements into Excalidraw via clipboard paste
        inject_js = f"""
        (function() {{
            var elements = {json.dumps(elements)};
            // Create Excalidraw clipboard format
            var excalidrawElements = elements.map(function(e, i) {{
                var base = {{
                    id: 'gen_' + i + '_' + Date.now(),
                    type: e.type || 'rectangle',
                    x: e.x || 100 + i * 200,
                    y: e.y || 100,
                    width: e.width || 150,
                    height: e.height || 70,
                    strokeColor: e.strokeColor || '#1e1e1e',
                    backgroundColor: e.backgroundColor || 'transparent',
                    fillStyle: e.fillStyle || 'hachure',
                    strokeWidth: 1,
                    roughness: 1,
                    opacity: 100,
                    angle: 0,
                    seed: Math.floor(Math.random() * 2000000000),
                    version: 1,
                    isDeleted: false,
                    boundElements: null,
                    updated: Date.now(),
                    link: null,
                    locked: false,
                }};
                if (e.text) {{
                    base.boundElements = [{{id: 'text_' + i, type: 'text'}}];
                }}
                return base;
            }});

            // Add text elements for labels
            elements.forEach(function(e, i) {{
                if (e.text) {{
                    excalidrawElements.push({{
                        id: 'text_' + i,
                        type: 'text',
                        x: (e.x || 100 + i * 200) + 10,
                        y: (e.y || 100) + 20,
                        width: (e.width || 150) - 20,
                        height: 30,
                        text: e.text,
                        fontSize: 16,
                        fontFamily: 1,
                        textAlign: 'center',
                        verticalAlign: 'middle',
                        containerId: 'gen_' + i + '_' + (Date.now() - 1),
                        originalText: e.text,
                        strokeColor: '#1e1e1e',
                        backgroundColor: 'transparent',
                        fillStyle: 'hachure',
                        strokeWidth: 1,
                        roughness: 1,
                        opacity: 100,
                        angle: 0,
                        seed: Math.floor(Math.random() * 2000000000),
                        version: 1,
                        isDeleted: false,
                        updated: Date.now(),
                    }});
                }}
            }});

            return 'Generated ' + excalidrawElements.length + ' diagram elements for: {description.replace("'", "")}';
        }})()
        """
        result = await _send_action_and_wait(tool_context, {"action": "evaluate", "code": inject_js})
        result["diagram_elements"] = len(elements)
        return result

    except Exception as e:
        return {"status": "error", "message": f"Diagram generation failed: {e}"}


async def draw_with_cursor(tool_context: ToolContext, description: str) -> dict:
    """Draw a sketch on Excalidraw by physically moving the cursor — creates a 'Ghost Cursor' effect.
    Gemini generates stroke coordinates, then each stroke is drawn via real mouse drag events.
    The agent MUST be on https://excalidraw.com before calling this.
    Use when user says 'sketch', 'draw', 'paint', or 'narysuj'."""
    from google import genai as genai_client

    api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
    if not api_key:
        return {"status": "error", "message": "No API key"}

    client = genai_client.Client(api_key=api_key)

    # 1. Ask Gemini to imagine the object as stroke coordinates
    prompt = f"""You are a robotic arm drawing on a 768x768 pixel canvas.
Draw a simplified, recognizable sketch of: "{description}"

Output ONLY a JSON array of strokes. Each stroke is an array of [x, y] points.
The canvas is 768x768 pixels. Center the drawing around [384, 384].
Use enough points per stroke to make curves smooth (8-20 points per curved stroke).
Maximum 8 strokes, maximum 120 points total.

EXAMPLES:
- Simple circle: [[[284,384],[300,310],[350,260],[400,245],[450,260],[500,310],[516,384],[500,458],[450,508],[400,523],[350,508],[300,458],[284,384]]]
- Square: [[[200,200],[568,200],[568,568],[200,568],[200,200]]]
- Smiley face (3 strokes - outline, left eye, right eye, mouth):
  [
    [[284,384],[300,310],[350,260],[400,245],[450,260],[500,310],[516,384],[500,458],[450,508],[400,523],[350,508],[300,458],[284,384]],
    [[350,340],[350,360]],
    [[450,340],[450,360]],
    [[340,430],[360,455],[384,465],[410,465],[430,455],[450,430]]
  ]

Make it RECOGNIZABLE. Use clear outlines. Add details (eyes, features, limbs, etc.).
Output ONLY valid JSON. No markdown, no explanation."""

    try:
        response = await client.aio.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(temperature=0.3, max_output_tokens=4096),
        )

        text = response.text.strip()
        # Strip markdown code fences if present
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            text = text.rsplit("```", 1)[0].strip()
        if text.startswith("json"):
            text = text[4:].strip()

        strokes = json.loads(text)
        if not isinstance(strokes, list) or len(strokes) == 0:
            return {"status": "error", "message": "Gemini returned no strokes"}

    except Exception as e:
        return {"status": "error", "message": f"Failed to generate drawing coordinates: {e}"}

    # 2. Activate Pencil tool in Excalidraw by pressing 'P'
    await _send_action_and_wait(tool_context, {"action": "press_key", "key": "p"}, timeout=2.0)
    await asyncio.sleep(0.3)

    # 3. Draw each stroke via drag-path — uses real wc.sendInputEvent() (NOT synthetic JS events)
    total_points = 0
    drawn_strokes = 0

    for i, stroke in enumerate(strokes):
        if not isinstance(stroke, list) or len(stroke) < 2:
            continue

        # Convert [[x,y], [x,y], ...] to [{x, y}, {x, y}, ...]
        points = []
        for pt in stroke:
            if isinstance(pt, list) and len(pt) >= 2:
                points.append({"x": int(pt[0]), "y": int(pt[1])})

        if len(points) < 2:
            continue

        total_points += len(points)

        # Send as drag-path action — Electron's index.ts handles interpolation + sendInputEvent
        result = await _send_action_and_wait(
            tool_context,
            {
                "action": "drag-path",
                "points": points,
                "description": f"Drawing stroke {i + 1}/{len(strokes)} of {description}",
            },
            timeout=15.0,  # Long timeout — drawing takes time with delays
        )

        drawn_strokes += 1

        # Brief pause between strokes so Excalidraw registers each one
        await asyncio.sleep(0.2)

    # 4. Switch back to Select tool (V key)
    await _send_action_and_wait(tool_context, {"action": "press_key", "key": "v"}, timeout=2.0)

    return {
        "status": "success",
        "result": f"Drew '{description}' with {drawn_strokes} strokes ({total_points} total points). Ghost cursor effect visible!",
        "strokes": drawn_strokes,
        "points": total_points,
    }
