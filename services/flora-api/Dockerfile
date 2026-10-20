FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
# Thai OCR models (PP-OCRv5 detector and Thai recogniser), checked by SHA256 and kept in the image: reading a
# document never downloads anything at run time.
COPY scripts/fetch_ocr_models.py ./scripts/
RUN python scripts/fetch_ocr_models.py /opt/flora-ocr
ENV FLORA_OCR_MODELS=/opt/flora-ocr \
    PYTHAINLP_DATA=/tmp/pythainlp-data
COPY app ./app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
