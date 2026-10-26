"""Install the pinned CPU speech runtime and public British voice at build time."""
import hashlib
from pathlib import Path
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / '.piper'
VOICE = 'en_GB-northern_english_male-medium'
REVISION = '5041a7a49ae5b3a0f30e6837769eb03fdbb231bd'
BASE = f'https://huggingface.co/rhasspy/piper-voices/resolve/{REVISION}/en/en_GB/northern_english_male/medium'

TARGET.mkdir(exist_ok=True)
subprocess.run([sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', '--only-binary=:all:', '--upgrade', '--target', str(TARGET / 'packages'), 'piper-tts==1.8.0', 'onnxruntime==1.23.2', 'numpy==2.2.6'], check=True)
for name in [VOICE + '.onnx', VOICE + '.onnx.json', 'MODEL_CARD']:
    target = TARGET / name
    temporary = target.with_suffix(target.suffix + '.download')
    with urllib.request.urlopen(BASE + '/' + name, timeout=90) as response, temporary.open('wb') as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    if name.endswith('.onnx'):
        digest = hashlib.sha256(temporary.read_bytes()).hexdigest()
        if digest != '57a219ae8e638873db7d18893304be5069c42868f392bb95c3ff17f0690d0689':
            raise ValueError('Voice model checksum mismatch')
    temporary.replace(target)
# The model and its attribution are downloaded from the same immutable revision.
print('Cloud Piper voice installed:', VOICE, flush=True)
