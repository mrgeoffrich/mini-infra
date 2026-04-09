# Stage 1: Build Python dependencies (gcc, cargo, etc. only needed here)
FROM alpine:3.21 AS builder

RUN apk update && apk upgrade && \
    apk add --no-cache py3-pip gcc musl-dev python3-dev libffi-dev openssl-dev cargo make

RUN pip install --break-system-packages --upgrade pip setuptools

COPY requirements.txt /tmp/
RUN pip install --break-system-packages --prefix=/install -r /tmp/requirements.txt

# Stage 2: Runtime image (no build toolchain)
FROM alpine:3.21

RUN apk update && apk upgrade && \
    apk add --no-cache openssl curl bash python3 postgresql-client

# Copy installed Python packages from builder
COPY --from=builder /install /usr

RUN mkdir /app
WORKDIR /app

COPY *.py /app/

ENV BACKUP_FORMAT=plain
ENV COMPRESSION_LEVEL=6

CMD ["python3", "/app/run.py"]
