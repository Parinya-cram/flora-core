FROM alpine:3.20
RUN apk add --no-cache dnsmasq
COPY dnsmasq.conf /etc/dnsmasq.conf
ENTRYPOINT ["dnsmasq","-k","--conf-file=/etc/dnsmasq.conf"]
