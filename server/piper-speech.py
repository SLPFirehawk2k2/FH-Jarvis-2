"""One bounded CPU speech job. Input is JSON on stdin, output is a WAV on stdout."""
import io
import json
from pathlib import Path
import sys
import wave

import onnxruntime
from piper import PiperVoice, SynthesisConfig
from piper.config import PiperConfig
from piper.voice import ESPEAK_DATA_DIR

root = Path(__file__).resolve().parents[1]
model = root / '.piper' / 'en_GB-northern_english_male-medium.onnx'
text = json.load(sys.stdin)['text']
if not isinstance(text, str) or not 1 <= len(text) <= 1200:
    raise ValueError('Speech text must contain 1–1200 characters')
options = onnxruntime.SessionOptions()
options.intra_op_num_threads = 1
options.inter_op_num_threads = 1
options.enable_cpu_mem_arena = False
with Path(str(model) + '.json').open() as config_file:
    config = PiperConfig.from_dict(json.load(config_file))
voice = PiperVoice(config=config, session=onnxruntime.InferenceSession(str(model), sess_options=options, providers=['CPUExecutionProvider']), espeak_data_dir=ESPEAK_DATA_DIR)
output = io.BytesIO()
with wave.open(output, 'wb') as wav_file:
    voice.synthesize_wav(text, wav_file, syn_config=SynthesisConfig(length_scale=1.08))
sys.stdout.buffer.write(output.getvalue())
