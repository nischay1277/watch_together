from pathlib import Path
from PIL import Image, ImageDraw
import subprocess
import io
import os

root = Path(__file__).resolve().parent.parent
os.environ['TEMP'] = os.environ['TMP'] = str(root / '.build-temp')
encoder = root / '.cache/ms-playwright/ffmpeg-1013/ffmpeg-win64.exe'
output = root / 'artifacts/browser-source-60fps.webm'
process = subprocess.Popen([str(encoder), '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-r', '60', '-c:v', 'mjpeg', '-i', 'pipe:0',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '6', '-b:v', '6M',
    '-pix_fmt', 'yuv420p', str(output)], stdin=subprocess.PIPE)
try:
    for frame in range(240):
        image = Image.new('RGB', (1920, 1080), (25 + frame % 90, 45, 35))
        draw = ImageDraw.Draw(image)
        for row in range(20):
            x = (frame * 19 + row * 173) % 1920
            draw.rectangle((x, 20 + row * 50, x + 130, 55 + row * 50), fill=(215, 235, 165))
        draw.text((30, 1040), f'PRIVATE GENERATED 60 FPS VIDEO - frame {frame}', fill='white')
        data = io.BytesIO(); image.save(data, 'JPEG', quality=90)
        process.stdin.write(data.getvalue())
finally:
    process.stdin.close()
if process.wait() != 0:
    raise SystemExit('Video fixture encoding failed')
print(f'Created {output} ({output.stat().st_size} bytes, 240 frames at 60 FPS)')
