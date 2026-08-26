#!/bin/sh
# pi-aeon installer — https://github.com/ucalyptus/pi-aeon
# Usage: curl -fsSL https://aeon.ucalyptus.me/install.sh | sh
#
# Env overrides:
#   PI_AEON_INSTALL_DIR   target dir (default ~/.local/bin)
#   PI_AEON_VERSION       release tag (default: latest release)
set -eu

REPO="ucalyptus/pi-aeon"
INSTALL_DIR="${PI_AEON_INSTALL_DIR:-$HOME/.local/bin}"

log() { printf '%s\n' "[pi-aeon] $*" >&2; }
fail() { printf '%s\n' "[pi-aeon] ERROR: $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required"; }
need uname
need curl
need shasum

# ---- platform detection (macOS only this release) ---------------------------
os=$(uname -s)
[ "$os" = "Darwin" ] || fail "this release supports macOS only (detected: $os)"
arch=$(uname -m)
case "$arch" in
  arm64|aarch64) arch_name="arm64" ;;
  x86_64|amd64) arch_name="x64" ;;
  *) fail "unsupported Mac architecture: $arch" ;;
esac
target="darwin-${arch_name}"
log "detected platform: $target"

# ---- resolve version -------------------------------------------------------
if [ -n "${PI_AEON_VERSION:-}" ]; then
  version="$PI_AEON_VERSION"
else
  version=$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/${REPO}/releases/latest" | sed 's|.*/tag/||')
  [ -n "$version" ] || fail "could not determine latest release"
  case "$version" in
    v*) : ;;
    *) fail "could not resolve latest release (got: '$version')" ;;
  esac
fi
log "installing pi-aeon ${version}"

base="https://github.com/${REPO}/releases/download/${version}"
tmp=$(mktemp -d /tmp/pi-aeon-install.XXXXXX)
trap 'rm -rf "$tmp"' EXIT

# ---- download + checksum verify --------------------------------------------
asset="pi-aeon-${target}"
log "downloading ${asset} …"
curl -fsSL "${base}/${asset}" -o "${tmp}/${asset}"
curl -fsSL "${base}/SHA256SUMS" -o "${tmp}/SHA256SUMS"

expected=$(grep " ${asset}\$" "${tmp}/SHA256SUMS" | cut -d' ' -f1)
[ -n "$expected" ] || fail "no checksum found for ${asset}"

actual=$(shasum -a 256 "${tmp}/${asset}" | cut -d' ' -f1)
[ "$actual" = "$expected" ] || fail "checksum mismatch:
  expected $expected
  actual   $actual"
log "checksum verified"

# ---- install ----------------------------------------------------------------
mkdir -p "$INSTALL_DIR"
mv "${tmp}/${asset}" "${INSTALL_DIR}/pi-aeon"
chmod +x "${INSTALL_DIR}/pi-aeon"
log "installed to ${INSTALL_DIR}/pi-aeon"

case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    log ""
    log "NOTE: ${INSTALL_DIR} is not on your PATH."
    log "Add this to your shell profile:"
    log "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac

cat >&2 <<EOF

[pi-aeon] done. Get started:
  export OPENROUTER_API_KEY=sk-or-v1-…     # required (model access)
  pi-aeon                                  # interactive TUI
  pi-aeon --headless --workspace ./demo "read README.md and summarize"

Formal verification requires the Aeon toolchain (auto-invoked):
  curl -LsSf https://astral.sh/uv/install.sh | sh   # provides uvx
  uv tool install aeonlang                          # or first run auto-installs

Docs: https://github.com/${REPO}
EOF
