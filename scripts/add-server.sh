#!/bin/bash

# Script to automatically add a new Minecraft server to the dashboard
# Usage: ./add-server.sh <name> <display_name> <jar_url> <min_memory> <max_memory> [server_type]
# Example: ./add-server.sh vanilla "Vanilla Server" "https://piston-data.mojang.com/v1/objects/8f3112a1049751cc472ec13e397eade5336ca7ae/server.jar" 2G 4G vanilla

set -euo pipefail
IFS=$'\n\t'

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "Error: required command not found: $1" >&2
        exit 1
    }
}

usage() {
    cat <<EOF
Usage: $0 <name> <display_name> <jar_url> <min_memory> <max_memory> [server_type]
server_type defaults to 'vanilla'
EOF
}

die() {
    echo "Error: $*" >&2
    exit 1
}

if [ $# -lt 5 ]; then
    usage
    exit 1
fi

NAME=$1
DISPLAY_NAME=$2
JAR_URL=$3
MIN_MEM=$4
MAX_MEM=$5
SERVER_TYPE=${6:-vanilla}

if ! [[ $NAME =~ ^[a-z0-9-]+$ ]]; then
    die "Server name must be lowercase letters, digits, and hyphens only"
fi

if [ "$SERVER_TYPE" != "vanilla" ] && [ "$SERVER_TYPE" != "fabric" ]; then
    die "server_type must be 'vanilla' or 'fabric'"
fi

# Paths
DASHBOARD_DIR="/srv/dashboard"
MCSERV_DIR="/srv/mcserv"
SERVER_DIR="$MCSERV_DIR/$NAME"
SERVERS_JSON="$DASHBOARD_DIR/servers.json"
ENV_FILE="$DASHBOARD_DIR/.env"

for cmd in wget openssl java systemctl timeout sed grep; do
    require_cmd "$cmd"
done

PYTHON_CMD=$(command -v python3 || command -v python || true)
[ -n "$PYTHON_CMD" ] || die "Python 3 or python is required"

# Check if server already exists
if [ -d "$SERVER_DIR" ]; then
    die "Server directory $SERVER_DIR already exists"
fi

# Check if name already in servers.json
if [ -f "$SERVERS_JSON" ]; then
    if "$PYTHON_CMD" - "$SERVERS_JSON" "$NAME" <<'PY'
import json
import sys

path = sys.argv[1]
name = sys.argv[2]
with open(path, 'r', encoding='utf-8') as f:
    cfg = json.load(f)
for server in cfg.get('servers', []):
    if server.get('name') == name:
        sys.exit(1)
sys.exit(0)
PY
    then
        die "Server $NAME already registered in servers.json"
    fi
fi

# Create server directory
if ! mkdir -p "$MCSERV_DIR" 2>/dev/null; then
    sudo mkdir -p "$MCSERV_DIR"
fi
if [ ! -w "$MCSERV_DIR" ]; then
    sudo chown "$USER:$USER" "$MCSERV_DIR"
fi
mkdir -p "$SERVER_DIR"
cd "$SERVER_DIR"

# Download jar
echo "Downloading server jar..."
JAR_NAME="server.jar"
if [ "$SERVER_TYPE" = "fabric" ]; then
    JAR_NAME="fabric-server-launch.jar"
fi
wget -O "$JAR_NAME" "$JAR_URL"

# Accept EULA
echo "eula=true" > eula.txt

# Find next available ports
RCON_PORT=25576
SERVER_PORT=25566

if [ -f "$SERVERS_JSON" ]; then
    mapfile -t USED_RCON_PORTS < <("$PYTHON_CMD" - "$SERVERS_JSON" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as f:
    cfg = json.load(f)
for server in cfg.get('servers', []):
    port = server.get('rcon', {}).get('port')
    if isinstance(port, int):
        print(port)
PY
)

    while printf '%s\n' "${USED_RCON_PORTS[@]:-}" | grep -qx "$RCON_PORT"; do
        RCON_PORT=$((RCON_PORT + 1))
    done

    USED_SERVER_PORTS=()
    shopt -s nullglob
    for prop in "$MCSERV_DIR"/*/server.properties; do
        if [ -f "$prop" ]; then
            port=$(grep '^server-port=' "$prop" | cut -d'=' -f2)
            if [[ $port =~ ^[0-9]+$ ]]; then
                USED_SERVER_PORTS+=("$port")
            fi
        fi
    done
    shopt -u nullglob

    while printf '%s\n' "${USED_SERVER_PORTS[@]:-}" | grep -qx "$SERVER_PORT"; do
        SERVER_PORT=$((SERVER_PORT + 1))
    done
fi

# Generate RCON password
RCON_PASSWORD=$(openssl rand -hex 24)

# Run server once to generate configs
echo "Generating server.properties..."
timeout 60 java -Xmx"$MAX_MEM" -jar "$JAR_NAME" nogui || true

# Edit server.properties
if [ -f server.properties ]; then
    set_property() {
        local key=$1
        local value=$2
        if grep -q "^$key=" server.properties; then
            sed -i "s|^$key=.*|$key=$value|" server.properties
        else
            echo "$key=$value" >> server.properties
        fi
    }

    set_property enable-rcon true
    set_property rcon.port "$RCON_PORT"
    set_property rcon.password "$RCON_PASSWORD"
    set_property white-list true
    set_property server-port "$SERVER_PORT"
else
    echo "server.properties not generated, creating manually..."
    cat > server.properties <<EOF
enable-rcon=true
rcon.port=$RCON_PORT
rcon.password=$RCON_PASSWORD
white-list=true
server-port=$SERVER_PORT
EOF
fi

# Create systemd unit
SYSTEMD_UNIT="mc-$NAME.service"
mkdir -p "$HOME/.config/systemd/user"
cp "$DASHBOARD_DIR/systemd/mc-vanilla.service" "$HOME/.config/systemd/user/$SYSTEMD_UNIT"
sed -i "s|WorkingDirectory=.*|WorkingDirectory=$SERVER_DIR|" "$HOME/.config/systemd/user/$SYSTEMD_UNIT"
sed -i "s|ExecStart=.*|ExecStart=/usr/bin/java -Xms$MIN_MEM -Xmx$MAX_MEM -jar $JAR_NAME nogui|" "$HOME/.config/systemd/user/$SYSTEMD_UNIT"

# Add RCON password to .env
ENV_VAR="RCON_PASSWORD_$(echo "$NAME" | tr 'a-z-' 'A-Z_')"
touch "$ENV_FILE"
if grep -q "^$ENV_VAR=" "$ENV_FILE" 2>/dev/null; then
    die "$ENV_VAR already exists in $ENV_FILE"
fi
printf '%s=%s\n' "$ENV_VAR" "$RCON_PASSWORD" >> "$ENV_FILE"

# Add to servers.json
"$PYTHON_CMD" - "$SERVERS_JSON" "$NAME" "$DISPLAY_NAME" "$SERVER_DIR" "$SYSTEMD_UNIT" "$RCON_PORT" "$ENV_VAR" <<'PY'
import json
import os
import sys

path, name, display_name, folder, systemd_unit, rcon_port, password_env = sys.argv[1:]
if os.path.exists(path):
    with open(path, 'r', encoding='utf-8') as f:
        cfg = json.load(f)
else:
    cfg = {
        '_comment': 'Registry of Minecraft servers managed by the dashboard.',
        'servers': []
    }
for server in cfg.get('servers', []):
    if server.get('name') == name:
        sys.exit(1)
entry = {
    'name': name,
    'display_name': display_name,
    'folder': folder,
    'systemd_unit': systemd_unit,
    'rcon': {
        'host': '127.0.0.1',
        'port': int(rcon_port),
        'password_env': password_env
    }
}
cfg.setdefault('servers', []).append(entry)
with open(path, 'w', encoding='utf-8') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
PY

# Reload systemd and restart dashboard
systemctl --user daemon-reload
systemctl --user enable "$SYSTEMD_UNIT"
systemctl --user restart dashboard

echo "Server $NAME added successfully!"
echo "RCON Port: $RCON_PORT"
echo "Server Port: $SERVER_PORT"
echo "Don't forget to grant access in the dashboard and start the server."