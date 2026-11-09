from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib
import json
import os
import subprocess

root = Path(__file__).resolve().parent.parent
release = root / 'release'
temp = root / '.build-temp'
temp.mkdir(exist_ok=True)
version = json.loads((root / 'package.json').read_text())['version']
os.environ['TEMP'] = os.environ['TMP'] = str(temp)
payload = temp / 'TogetherPayload.zip'
with ZipFile(payload, 'w', ZIP_DEFLATED, compresslevel=6) as archive:
    package = release / 'win-unpacked'
    for path in sorted(package.rglob('*')):
        if path.is_file() and 'Together-data' not in path.relative_to(package).parts:
            archive.write(path, path.relative_to(package).as_posix())
digest = hashlib.sha256()
with payload.open('rb') as source_payload:
    for chunk in iter(lambda: source_payload.read(1024 * 1024), b''):
        digest.update(chunk)
payload_id = version + '-' + digest.hexdigest()[:16]
source = (root / 'tools/PortableLauncher.cs').read_text().replace('@@PAYLOAD_ID@@', payload_id).replace('@@ASSEMBLY_VERSION@@', version + '.0')
generated = temp / 'PortableLauncher.cs'
generated.write_text(source, encoding='utf-8-sig')
compiler = Path(os.environ.get('WINDIR', r'C:\Windows')) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
output = release / f'Together-{version}-Windows.exe'
subprocess.run([str(compiler), '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
                '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
                '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
                '/win32icon:' + str(root / 'assets/icon.ico'),
                '/resource:' + str(payload) + ',TogetherPayload.zip', '/out:' + str(output), str(generated)], check=True)
print(f'Built {output} ({output.stat().st_size} bytes); runtime/data stay beside the EXE.', flush=True)
