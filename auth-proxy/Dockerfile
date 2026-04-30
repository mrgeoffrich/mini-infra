FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/auth-proxy ./cmd

FROM alpine:3.20
RUN apk add --no-cache ca-certificates && adduser -D -u 1000 auth-proxy
COPY --from=build /out/auth-proxy /usr/local/bin/auth-proxy
USER auth-proxy
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/auth-proxy"]
