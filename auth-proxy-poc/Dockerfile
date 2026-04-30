FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 go build -o /out/auth-proxy ./

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /out/auth-proxy /usr/local/bin/auth-proxy
USER nobody
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/auth-proxy"]
