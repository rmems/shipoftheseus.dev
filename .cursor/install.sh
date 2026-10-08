#!/usr/bin/env bash
# Cursor Cloud Agent install script for shipoftheseus.dev (`install` in .cursor/environment.json).
#
# Cursor runs this from the repository root during every Build, on its default
# Ubuntu base image (CPU only: cloud agents have no GPU), then snapshots the disk.
# It must be idempotent. Shell exports don't survive into agent runs, so the tools
# it installs are exposed through /etc/profile.d and /usr/local/bin.
# See https://cursor.com/docs/cloud-agent/setup
#
# Installs only what this repo's CI and manifests need:
#   - apt: build-essential, pkg-config, curl, ca-certificates
#   - Rust 1.98.1 (+rustfmt, clippy) target wasm32-unknown-unknown [default]
#   - wasm-bindgen-cli 0.2.126 (cargo install --locked)
#   - Node 22.12.0 (CI pin) unless the base image's Node satisfies package.json engines
#   - npm ci
#   - cargo fetch --locked (crates/neuromorphic-adapter)
#   - tool directories exposed to later shells (/etc/profile.d + /usr/local/bin links)
#
# It ends with a dependency fetch/prebuild, not a test run.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

# Install apt packages that are not already present.
apt_install() {
  local missing=() pkg
  for pkg in "$@"; do
    if ! dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed"; then
      missing+=("$pkg")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    $SUDO apt-get -o Acquire::Retries=5 update -qq
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y --no-install-recommends "${missing[@]}"
  fi
}

# --- System packages (C toolchain/linker for rustc and cargo install; curl for the installers) ---
apt_install build-essential pkg-config curl ca-certificates xz-utils

# --- Rust (rustup) ---
export PATH="$HOME/.cargo/bin:$PATH"
if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
    sh -s -- -y --default-toolchain none --profile minimal
fi
# crates/neuromorphic-adapter/rust-toolchain.toml + quality.yml: 1.98.1, wasm32-unknown-unknown, rustfmt, clippy.
rustup toolchain install 1.98.1 --profile minimal --component rustfmt --component clippy --target wasm32-unknown-unknown
rustup default 1.98.1

# quality.yml installs wasm-bindgen-cli 0.2.126 for the wasm adapter checks.
if ! wasm-bindgen --version 2>/dev/null | grep -q '0\.2\.126'; then
  cargo install wasm-bindgen-cli --version 0.2.126 --locked
fi

# --- Node ---
# package.json engines: ^20.19.0 || >=22.12.0. CI (quality.yml) uses 22.12.0, so
# install that release into /usr/local when the base image's Node is missing or too old.
NODE_VERSION="22.12.0"
node_ok() {
  command -v node >/dev/null 2>&1 && node -e '
const [maj, min] = process.versions.node.split(".").map(Number);
const ok = (maj === 20 && min >= 19) || maj > 22 || (maj === 22 && min >= 12);
process.exit(ok ? 0 : 1);
'
}
if ! node_ok; then
  node_dist="node-v${NODE_VERSION}-linux-x64"
  node_tmp="$(mktemp -d)"
  curl --proto '=https' --tlsv1.2 -fsSL -o "$node_tmp/$node_dist.tar.xz" \
    "https://nodejs.org/dist/v${NODE_VERSION}/${node_dist}.tar.xz"
  curl --proto '=https' --tlsv1.2 -fsSL -o "$node_tmp/SHASUMS256.txt" \
    "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  (cd "$node_tmp" && grep -F "  ${node_dist}.tar.xz" SHASUMS256.txt | sha256sum -c -)
  $SUDO tar -xJf "$node_tmp/$node_dist.tar.xz" -C /usr/local --strip-components=1 --no-same-owner \
    "$node_dist/bin" "$node_dist/include" "$node_dist/lib" "$node_dist/share"
  rm -rf "$node_tmp"
  hash -r
  node_ok
fi
npm ci

# --- Prefetch crates (no build, no tests) ---
cargo fetch --locked --manifest-path crates/neuromorphic-adapter/Cargo.toml

# --- Expose the tools to later shells ---
# The PATH exports above last only for this script; Cursor starts the agent's shells
# separately. Login shells get these directories from /etc/profile.d, and every other
# shell finds the entry points through symlinks in /usr/local/bin (on the default PATH).
tool_dirs=("$HOME/.cargo/bin")
# shellcheck disable=SC2016 # $PATH must expand when the profile is sourced, not now.
printf 'export PATH="%s:$PATH"\n' "$(IFS=:; echo "${tool_dirs[*]}")" |
  $SUDO tee /etc/profile.d/cursor-env-shipoftheseus.dev.sh >/dev/null
for dir in "${tool_dirs[@]}"; do
  [ -d "$dir" ] || continue
  for tool in "$dir"/*; do
    name="${tool##*/}"
    case "$name" in
      python* | pip* | activate* | deactivate | Activate.ps1) continue ;;
    esac
    if [ -f "$tool" ] && [ -x "$tool" ]; then
      $SUDO ln -sfn "$tool" "/usr/local/bin/$name"
    fi
  done
done

echo "Cursor install for shipoftheseus.dev finished."
