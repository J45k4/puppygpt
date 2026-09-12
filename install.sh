#!/usr/bin/env bash
set -euo pipefail
umask 077

# Trust anchor: keep identical to src/update/trust.ts. Never download a replacement key.
PUBLIC_KEY='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA1YupSfADfEDx4GCTXiuvClBUag2df+o+jwkRx7wJTvg=
-----END PUBLIC KEY-----'
REPOSITORY=J45k4/puppygpt
version=latest
port=3000
start=true
usage() {
  cat <<'HELP'
Usage: bash install.sh [--version v0.0.1] [--port 3000] [--no-start]

Install a verified PuppyGPT binary as puppygpt.service for the current user.
Requires Linux, a running systemd user manager, curl, jq and OpenSSL 3+.
No sudo and no Bun installation needed. --no-start writes files without enabling
or starting the service. Existing installations are never overwritten.

Paths follow XDG_DATA_HOME and XDG_CONFIG_HOME (or ~/.local/share and ~/.config).
HELP
}
fail() { echo "Error: $*" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --version) (($# >= 2)) || fail '--version needs a value'; version=$2; shift 2 ;;
    --port) (($# >= 2)) || fail '--port needs a value'; port=$2; shift 2 ;;
    --no-start) start=false; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
[[ $EUID != 0 ]] || fail 'Run as your regular user, without sudo.'
[[ $(uname -s) == Linux ]] || fail 'This service installer requires Linux with systemd.'
case "$(uname -m)" in
  x86_64) asset=puppygpt-linux-x64 ;;
  aarch64|arm64) asset=puppygpt-linux-arm64 ;;
  *) fail 'Supported architectures: x86_64 and arm64.' ;;
esac
[[ $port =~ ^[1-9][0-9]{0,4}$ ]] && ((port <= 65535)) || fail 'Invalid port.'
[[ $version == latest || $version =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail 'Expected --version vMAJOR.MINOR.PATCH.'
for dependency in curl jq openssl systemctl sha256sum stat install mktemp rmdir; do
  command -v "$dependency" >/dev/null || fail "Missing dependency: $dependency"
done
[[ $(openssl version) == 'OpenSSL 3.'* || $(openssl version) == 'OpenSSL 4.'* ]] || fail 'OpenSSL 3 or newer is required for Ed25519 verification.'

app_dir=${XDG_DATA_HOME:-$HOME/.local/share}/puppygpt
config_dir=${XDG_CONFIG_HOME:-$HOME/.config}/puppygpt
unit_dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
unit=$unit_dir/puppygpt.service
# These characters need extra systemd escaping. Reject them instead of interpreting them.
for path in "$HOME" "$app_dir" "$config_dir" "$unit_dir"; do
  [[ $path == /* && $path != *[$'\n\r\t\\"%$']* ]] || fail 'Installation paths must be absolute and cannot contain control characters, quotes, backslashes, % or $.'
done
[[ ! -e $app_dir && ! -L $app_dir && ! -e $config_dir && ! -L $config_dir && ! -e $unit && ! -L $unit ]] || fail 'PuppyGPT installation/configuration already exists. Use systemctl --user restart puppygpt; automatic updates manage existing installations.'
if $start; then
  systemctl --user show-environment >/dev/null || fail 'No systemd user session is available. Log in normally or use --no-start.'
  # Do not collide with an existing development server or another application.
  if curl --silent --output /dev/null --max-time 2 "http://127.0.0.1:$port/"; then
    fail "Port $port is already serving HTTP. Stop that server or choose --port."
  fi
fi
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
fetch() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 180 --max-filesize "$3" --output "$2" "$1"
}
if [[ $version == latest ]]; then
  fetch "https://api.github.com/repos/$REPOSITORY/releases/latest" "$scratch/release.json" 1048576
  version=$(jq -er 'select(.draft == false and .prerelease == false) | .tag_name | strings' "$scratch/release.json")
  [[ $version =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail 'Latest release has an invalid version.'
fi
base=https://github.com/$REPOSITORY/releases/download/$version
printf 'Downloading and verifying PuppyGPT %s…\n' "$version"
fetch "$base/manifest.json" "$scratch/manifest.json" 65536
fetch "$base/manifest.sig" "$scratch/manifest.sig" 64
printf '%s\n' "$PUBLIC_KEY" > "$scratch/public.pem"
[[ $(stat -c %s "$scratch/manifest.sig") == 64 ]] || fail 'Invalid signature length.'
openssl pkeyutl -verify -rawin -pubin -inkey "$scratch/public.pem" \
  -in "$scratch/manifest.json" -sigfile "$scratch/manifest.sig" >/dev/null || fail 'Release signature verification failed.'
metadata=$(jq -er --arg repository "$REPOSITORY" --arg version "$version" --arg name "$asset" '
  select(.schema == 1 and .repository == $repository and .version == $version)
  | .assets | select(type == "array" and length <= 8)
  | map(select(.name == $name)) | select(length == 1) | .[0]
  | select((.size | type) == "number" and .size >= 1 and .size <= 268435456 and .size == (.size | floor))
  | select(.sha256 | test("^[a-f0-9]{64}$"))
  | [.size, .sha256] | @tsv' "$scratch/manifest.json") || fail 'Invalid release manifest or unsupported platform.'
read -r size digest <<< "$metadata"
fetch "$base/$asset" "$scratch/puppygpt" "$size"
[[ $(stat -c %s "$scratch/puppygpt") == "$size" ]] || fail 'Binary size mismatch.'
[[ $(sha256sum "$scratch/puppygpt" | cut -d ' ' -f 1) == "$digest" ]] || fail 'Binary checksum mismatch.'

# No installation files or executables are created until verification succeeds.
mkdir -p -- "$app_dir/bin" "$app_dir/data/updates" "$app_dir/workspace" "$config_dir" "$unit_dir"
install -m 700 "$scratch/puppygpt" "$app_dir/bin/puppygpt"
cat > "$config_dir/service.env" <<ENV
PORT=$port
PUPPYGPT_DATA_DIR="$app_dir/data"
PUPPYGPT_WORKDIR="$app_dir/workspace"
PUPPYGPT_UPDATE_DIR="$app_dir/data/updates"
ENV
cat > "$unit" <<UNIT
# Managed by the PuppyGPT installer.
[Unit]
Description=PuppyGPT with verified automatic updates
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=$app_dir/workspace
EnvironmentFile=$config_dir/service.env
Environment="PATH=$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart="$app_dir/bin/puppygpt" --auto-update
# systemd first stops the entire service cgroup; remove only its empty lock.
ExecStopPost=-$(command -v rmdir) "$app_dir/data/updates/supervisor.lock"
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=45
UMask=0077

[Install]
WantedBy=default.target
UNIT
chmod 600 "$unit" "$config_dir/service.env"
if $start; then
  systemctl --user daemon-reload
  systemctl --user enable --now puppygpt.service
  ready=false
  for ((attempt=0; attempt<60; attempt++)); do
    if systemctl --user is-active --quiet puppygpt.service && curl --fail --silent --output /dev/null --max-time 1 "http://127.0.0.1:$port/"; then
      ready=true; break
    fi
    sleep 1
  done
  $ready || fail 'Installed, but startup did not become ready. Inspect: journalctl --user -u puppygpt -n 80'
  printf 'PuppyGPT is running at http://127.0.0.1:%s\n' "$port"
else
  echo 'Installed without starting. Run:'
  echo '  systemctl --user daemon-reload'
  echo '  systemctl --user enable --now puppygpt'
fi
printf '\nConfiguration: %s/service.env\nData: %s/data\n' "$config_dir" "$app_dir"
echo 'Logs: journalctl --user -u puppygpt -f'
echo 'The service starts on login. For startup at boot without login: loginctl enable-linger "$USER"'
