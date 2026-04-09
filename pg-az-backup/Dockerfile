FROM alpine:3.21

RUN apk update && apk upgrade && \
    apk add --no-cache bash curl postgresql-client gzip

RUN mkdir /app
WORKDIR /app

COPY *.sh /app/
RUN chmod +x /app/*.sh

ENV BACKUP_FORMAT=plain
ENV COMPRESSION_LEVEL=6

CMD ["/app/run.sh"]
