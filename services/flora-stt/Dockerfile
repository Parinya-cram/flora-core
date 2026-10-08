# Flora STT: offline speech-to-text for a Leaf (faster-whisper on CPU).
# Both models are downloaded at build time and baked into the image, so the
# running service never needs the internet.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# STT_MODEL commits each utterance (accurate); STT_DRAFT_MODEL shows live text (fast).
ARG STT_MODEL=large-v3-turbo
ARG STT_DRAFT_MODEL=small
ENV STT_MODEL=${STT_MODEL} \
    STT_DRAFT_MODEL=${STT_DRAFT_MODEL} \
    STT_MODEL_ROOT=/models \
    HF_HUB_OFFLINE=1
RUN HF_HUB_OFFLINE=0 python -c "import os; from faster_whisper import download_model; [download_model(m, output_dir=f'/models/{m}') for m in {os.environ['STT_MODEL'], os.environ['STT_DRAFT_MODEL']}]"

COPY app ./app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
