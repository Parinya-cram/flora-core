FROM nginx:1.27-alpine
RUN apk add --no-cache openssl && mkdir -p /etc/nginx/certs && \
    openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
      -keyout /etc/nginx/certs/flora.key -out /etc/nginx/certs/flora.crt \
      -subj "/CN=*.flora.local" \
      -addext "subjectAltName=DNS:*.flora.local,DNS:flora.local,DNS:leaf.flora.local,DNS:canopy.flora.local,DNS:root.flora.local"
COPY nginx.conf /etc/nginx/conf.d/default.conf
