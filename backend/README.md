# OliveFly Sentinel Backend (ML + WhatsApp)

This backend exposes:
- `POST /api/detect` for insect counting from images (YOLO model).
- `POST /api/notify/whatsapp` for automatic WhatsApp messages (Cloud API).
- `GET /api/health` for status.

## Setup
1) Create a virtual environment and install deps:
```bash
python -m venv .venv
.venv\\Scripts\\activate
pip install -r requirements.txt
```

2) Place your model weights:
```
backend/weights/olivefly.pt
```

3) Configure env vars (example):
```
MODEL_PATH=weights/olivefly.pt
TARGET_CLASSES=fly,olivefly
API_KEY=changeme
WHATSAPP_TOKEN=your_token
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_API_VERSION=v17.0
PORT=8080
```

4) Run:
```bash
python app.py
```

## Notes
- You must provide a trained model for olive fly detection.
- Use the `API_KEY` header as `x-api-key` in the PWA if set.
