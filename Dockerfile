FROM node:22-alpine AS webbuild
WORKDIR /app/web
COPY web/package.json ./
RUN npm install
COPY web/ ./
RUN npm run build \
  && test -f dist/assets/app.js \
  && grep -q "viewer-stage" dist/assets/app.js \
  && ! grep -q "zoomInBtn" dist/assets/app.js \
  && ! grep -q "zoom-fab" dist/assets/app.js \
  && ! grep -q "zoomHud" dist/assets/app.js

FROM golang:1.26-alpine AS gobuild
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=webbuild /app/web/dist ./web/dist
RUN test -f web/dist/assets/app.js \
  && ! grep -q "zoomInBtn" web/dist/assets/app.js \
  && go mod tidy && CGO_ENABLED=0 go build -o /out/docker-reader ./cmd/reader

FROM alpine:3.21
RUN adduser -D -H -u 10001 appuser
WORKDIR /app
COPY --from=gobuild /out/docker-reader /usr/local/bin/docker-reader
USER appuser
ENV DATA_DIR=/data
ENV CONFIG=/data/config.json
EXPOSE 3433
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/docker-reader"]
