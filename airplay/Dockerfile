FROM debian:bookworm

RUN apt-get update && \
    apt-get install -y \
        shairport-sync \
        avahi-daemon \
        avahi-utils \
        libsoxr0 \
        && \
    rm -rf /var/lib/apt/lists/*

RUN mkfifo /tmp/airplay_pipe

COPY shairport-sync.conf /etc/shairport-sync.conf

CMD ["shairport-sync", "-c", "/etc/shairport-sync.conf", "--verbose"]
