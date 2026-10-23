"""Opt-in, CPU-only local ONNX embedding endpoint. Never downloads a model.

Requires onnxruntime, tokenizers and numpy in a separate Python environment.
Designed for mean-pooled encoder models such as multilingual-e5-small.
The configured revision must identify the exact local model artifacts.
"""
import argparse
import hashlib
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-directory', required=True)
    parser.add_argument('--model', default='Xenova/multilingual-e5-small')
    parser.add_argument('--revision', required=True)
    parser.add_argument('--port', type=int, default=5083)
    args = parser.parse_args()
    directory = Path(args.model_directory).resolve()
    model_path = directory / 'model_quantized.onnx'
    tokenizer_path = directory / 'tokenizer.json'
    # Digest lets the caller pin the actual local files, including quantization.
    digest = hashlib.sha256(model_path.read_bytes() + tokenizer_path.read_bytes()).hexdigest()
    if args.revision != digest:
        raise SystemExit('Revision must equal SHA-256(model_quantized.onnx bytes + tokenizer.json bytes): ' + digest)
    tokenizer = Tokenizer.from_file(str(tokenizer_path))
    tokenizer.enable_padding(pad_id=1, pad_token='<pad>')
    tokenizer.enable_truncation(max_length=512)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(model_path), sess_options=options, providers=['CPUExecutionProvider'])

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # No request/content logging.

        def reply(self, status, payload):
            body = json.dumps(payload, separators=(',', ':')).encode()
            try:
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass  # A canceled client is normal; never log request content.

        def do_POST(self):
            try:
                if self.path != '/v1/embeddings':
                    return self.reply(404, {'error': 'Unknown endpoint'})
                length = int(self.headers.get('Content-Length', '0'))
                if length < 1 or length > 131072:
                    return self.reply(413, {'error': 'Request exceeds limit'})
                request = json.loads(self.rfile.read(length))
                texts = request.get('input')
                if request.get('model') != args.model or request.get('revision') != args.revision:
                    return self.reply(409, {'error': 'Model/revision mismatch'})
                if not isinstance(texts, list) or not 1 <= len(texts) <= 16 or any(not isinstance(x, str) or len(x) > 2048 for x in texts):
                    return self.reply(400, {'error': 'Invalid input'})
                encoded = tokenizer.encode_batch(texts)
                ids = np.asarray([e.ids for e in encoded], dtype=np.int64)
                mask = np.asarray([e.attention_mask for e in encoded], dtype=np.int64)
                inputs = {'input_ids': ids, 'attention_mask': mask, 'token_type_ids': np.zeros_like(ids)}
                outputs = session.run(None, {entry.name: inputs[entry.name] for entry in session.get_inputs()})
                hidden = outputs[0]
                if hidden.ndim == 3:
                    expanded = mask[..., None]
                    vectors = (hidden * expanded).sum(axis=1) / np.maximum(expanded.sum(axis=1), 1)
                elif hidden.ndim == 2:
                    vectors = hidden
                else:
                    raise ValueError('Unsupported ONNX encoder output')
                vectors = vectors / np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-12)
                self.reply(200, {'model': args.model, 'revision': args.revision,
                                 'data': [{'index': i, 'embedding': vector.tolist()} for i, vector in enumerate(vectors)]})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                self.reply(400, {'error': 'Local embedding inference failed'})

    server = HTTPServer(('127.0.0.1', args.port), Handler)
    server.timeout = 30
    print(json.dumps({'ready': True, 'model': args.model, 'revision': args.revision, 'port': args.port}), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
