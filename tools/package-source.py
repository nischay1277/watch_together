from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
directories = ['desktop', 'public', 'assets', 'test', 'tools']
files = ['package.json', 'package-lock.json', 'server.cjs', 'README.md', 'QUICK-START.md',
         'VALIDATION.md', 'LICENSE', 'Dockerfile', 'render.yaml', 'playwright.config.cjs',
         '.env.example', '.gitignore', '.dockerignore', '.npmrc', 'vendor/CLOUDFLARED-LICENSE',
         'vendor/CLOUDFLARED-VERSION.json']
paths = [root / name for name in files]
for directory in directories:
    paths.extend(path for path in (root / directory).rglob('*')
                 if path.is_file() and '__pycache__' not in path.parts)
output = root / 'release' / 'Together-source.zip'
output.parent.mkdir(exist_ok=True)
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for path in sorted(paths):
        archive.write(path, path.relative_to(root).as_posix())
print(f'Source packaged: {output} ({output.stat().st_size} bytes)')
