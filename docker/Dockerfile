# CI-parity toolchain: run checks and Linux packaging without installing
# anything on the host. GUI smoke needs a display and stays outside Docker.
FROM node:24-bookworm

# electron-builder's Linux targets want these for AppImage/deb assembly.
RUN apt-get update && apt-get install -y --no-install-recommends \
    fakeroot rpm libarchive-tools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work
