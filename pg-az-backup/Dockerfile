FROM alpine:3.23

RUN apk update && apk upgrade && \
    apk add --no-cache bash curl postgresql-client gzip nodejs npm

RUN mkdir /app
WORKDIR /app

# Install the googleapis client used by the Drive upload/download scripts.
# Keeping this in /app/node_modules so the .mjs scripts can `import` directly.
COPY package.json /app/
RUN npm install --omit=dev --no-package-lock && rm -rf /root/.npm

COPY *.sh /app/
COPY *.mjs /app/
RUN chmod +x /app/*.sh

ENV BACKUP_FORMAT=plain
ENV COMPRESSION_LEVEL=6
ENV STORAGE_PROVIDER=azure

CMD ["/app/run.sh"]
