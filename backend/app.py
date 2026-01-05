import io
import os
import time
from typing import List, Optional

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image
import requests

try:
    from ultralytics import YOLO
    _YOLO_AVAILABLE = True
except Exception:
    YOLO = None
    _YOLO_AVAILABLE = False


APP_NAME = "OliveFly Sentinel Backend"
MODEL_PATH = os.getenv("MODEL_PATH", "weights/olivefly.pt")
TARGET_CLASSES = [c.strip() for c in os.getenv("TARGET_CLASSES", "").split(",") if c.strip()]
API_KEY = os.getenv("API_KEY", "")

WHATSAPP_TOKEN = os.getenv("WHATSAPP_TOKEN", "")
WHATSAPP_PHONE_NUMBER_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID", "")
WHATSAPP_API_VERSION = os.getenv("WHATSAPP_API_VERSION", "v17.0")

app = FastAPI(title=APP_NAME)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_model = None


def _load_model():
    global _model
    if _model is not None:
        return _model
    if not _YOLO_AVAILABLE:
        return None
    if not os.path.exists(MODEL_PATH):
        return None
    _model = YOLO(MODEL_PATH)
    return _model


def _require_key(x_api_key: Optional[str]):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


class WhatsappRequest(BaseModel):
    to: str
    text: str


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "model_loaded": bool(_load_model()),
        "model_path": MODEL_PATH,
    }


@app.post("/api/detect")
async def detect(
    file: UploadFile = File(...),
    min_conf: float = 0.25,
    x_api_key: Optional[str] = Header(default=None),
):
    _require_key(x_api_key)
    model = _load_model()
    if model is None:
        raise HTTPException(status_code=500, detail="Model not available")

    try:
        content = await file.read()
        image = Image.open(io.BytesIO(content)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid image") from exc

    min_conf = max(0.05, min(0.95, float(min_conf)))
    started = time.time()
    results = model(image)
    elapsed_ms = int((time.time() - started) * 1000)

    detections = []
    count = 0
    avg_conf = 0.0
    names = results[0].names if results else {}
    for box in results[0].boxes:
        conf = float(box.conf[0]) if hasattr(box.conf, "__len__") else float(box.conf)
        if conf < min_conf:
            continue
        cls_id = int(box.cls[0]) if hasattr(box.cls, "__len__") else int(box.cls)
        label = names.get(cls_id, str(cls_id))
        if TARGET_CLASSES and label not in TARGET_CLASSES:
            continue
        xyxy = box.xyxy[0].tolist()
        detections.append({
            "label": label,
            "conf": round(conf, 4),
            "box": [round(x, 2) for x in xyxy],
        })
        count += 1
        avg_conf += conf

    if count:
        avg_conf = avg_conf / count

    return {
        "count": count,
        "avg_conf": round(avg_conf, 4) if count else 0.0,
        "detections": detections,
        "inference_ms": elapsed_ms,
        "min_conf": min_conf,
        "model": os.path.basename(MODEL_PATH),
    }


@app.post("/api/notify/whatsapp")
def notify_whatsapp(payload: WhatsappRequest, x_api_key: Optional[str] = Header(default=None)):
    _require_key(x_api_key)
    if not WHATSAPP_TOKEN or not WHATSAPP_PHONE_NUMBER_ID:
        raise HTTPException(status_code=500, detail="WhatsApp credentials missing")

    url = f"https://graph.facebook.com/{WHATSAPP_API_VERSION}/{WHATSAPP_PHONE_NUMBER_ID}/messages"
    headers = {
        "Authorization": f"Bearer {WHATSAPP_TOKEN}",
        "Content-Type": "application/json",
    }
    body = {
        "messaging_product": "whatsapp",
        "to": payload.to,
        "type": "text",
        "text": {"body": payload.text},
    }

    res = requests.post(url, headers=headers, json=body, timeout=15)
    if not res.ok:
        raise HTTPException(status_code=500, detail=f"WhatsApp send failed: {res.text}")
    return {"status": "sent", "to": payload.to}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
