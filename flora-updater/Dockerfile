# flora-updater: one image for every tier (Canopy, Leaf, Gateway). See updater.py.
FROM docker:28-cli
RUN apk add --no-cache python3 py3-cryptography
COPY updater.py /app/updater.py
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python3", "/app/updater.py"]
