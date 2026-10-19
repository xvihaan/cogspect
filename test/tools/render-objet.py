"""Render a prospect desk model: run its render.html in headless Chrome (Metal,
so WebGL exists) and write the two passes it prints to objet.png / shadow.png,
cropped to the union of their visible pixels so the pair stays registered.

    python3 test/tools/render-objet.py glass
"""
import base64, html, json, re, subprocess, sys, io, os
pid = sys.argv[1]
chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
out = subprocess.run([chrome, "--headless=new", "--use-angle=metal", "--virtual-time-budget=15000",
                      "--dump-dom", f"http://127.0.0.1:4173/prospect/{pid}/render.html"],
                     capture_output=True, text=True).stdout
m = re.search(r'<pre id="out"[^>]*>(.*?)</pre>', out, re.S)
data = json.loads(html.unescape(m.group(1)))
for name in ("objet", "shadow"):
    png = base64.b64decode(data[name].split(",", 1)[1])
    open(f"prospect/{pid}/{name}.png", "wb").write(png)
    print(name, len(png), "bytes")
