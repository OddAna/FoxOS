FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS frontend-builder

WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS thumbnailer-builder

ARG FFMPEG_VERSION=8.1.2
ARG FFMPEG_ARCHIVE_SHA256=464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates curl gnupg nasm pkg-config xz-utils zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

RUN curl --fail --silent --show-error --location \
      --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 20 --max-time 300 --remove-on-error \
      --output ffmpeg.tar.xz \
      "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
    && curl --fail --silent --show-error --location \
      --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 20 --max-time 300 --remove-on-error \
      --output ffmpeg.tar.xz.asc \
      "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz.asc" \
    && curl --fail --silent --show-error --location \
      --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 20 --max-time 300 --remove-on-error \
      --output ffmpeg-devel.asc \
      https://ffmpeg.org/ffmpeg-devel.asc \
    && echo "${FFMPEG_ARCHIVE_SHA256}  ffmpeg.tar.xz" | sha256sum --check --strict \
    && gpg --batch --import ffmpeg-devel.asc \
    && test "$(gpg --batch --with-colons --fingerprint ffmpeg-devel@ffmpeg.org | awk -F: '$1 == "fpr" { print $10; exit }')" = \
      FCF986EA15E6E293A5644F10B4322F04D67658D8 \
    && gpg --batch --verify ffmpeg.tar.xz.asc ffmpeg.tar.xz \
    && tar --extract --file ffmpeg.tar.xz \
    && cd "ffmpeg-${FFMPEG_VERSION}" \
    && ./configure \
      --prefix=/opt/foxos-thumbnailer \
      --disable-autodetect \
      --disable-debug \
      --disable-doc \
      --disable-everything \
      --disable-network \
      --disable-static \
      --enable-shared \
      --enable-ffmpeg \
      --enable-avcodec \
      --enable-avfilter \
      --enable-avformat \
      --enable-swscale \
      --enable-zlib \
      --enable-protocol=file \
      --enable-demuxer=gif,image2,matroska,mov \
      --enable-decoder=av1,gif,h264,hevc,mjpeg,mpeg4,png,prores,vp8,vp9,webp \
      --enable-encoder=mjpeg \
      --enable-muxer=image2 \
      --enable-parser=av1,h264,hevc,mjpeg,mpeg4video,vp8,vp9 \
      --enable-filter=crop,format,hflip,scale,transpose,vflip \
      --extra-cflags=-Os \
      --extra-ldflags=-Wl,-rpath,/opt/foxos-thumbnailer/lib \
    && make -j2 ffmpeg \
    && make install \
    && strip /opt/foxos-thumbnailer/bin/ffmpeg /opt/foxos-thumbnailer/lib/*.so.* \
    && mkdir -p /opt/foxos-thumbnailer/licenses \
    && cp COPYING.LGPLv2.1 COPYING.LGPLv3 LICENSE.md /opt/foxos-thumbnailer/licenses/ \
    && rm -rf /opt/foxos-thumbnailer/include /opt/foxos-thumbnailer/lib/pkgconfig /opt/foxos-thumbnailer/share \
    && /opt/foxos-thumbnailer/bin/ffmpeg -version

FROM node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS backend-deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS runtime

ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap ca-certificates curl git openssl tar util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/package*.json ./
COPY --from=backend-deps /build/backend/node_modules ./node_modules
COPY backend/ ./
COPY skills/ ./skills/
COPY --from=frontend-builder /build/frontend/dist ./public
COPY --from=thumbnailer-builder /opt/foxos-thumbnailer /opt/foxos-thumbnailer

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:8080/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
