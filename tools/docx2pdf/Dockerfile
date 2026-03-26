FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer-nogui \
    libreoffice-java-common \
    default-jre-headless \
    fonts-liberation \
    fonts-noto \
    xvfb \
    python3 \
    python3-docx \
    && rm -rf /var/lib/apt/lists/*

COPY convert.sh /usr/local/bin/convert.sh
RUN chmod +x /usr/local/bin/convert.sh

ENTRYPOINT ["/usr/local/bin/convert.sh"]
