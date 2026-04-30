# Minecraft dashboard

A self-hosted web dashboard for managing Minecraft servers on a Linux box.

Login-protected, role-based, with audit logging, an in-browser terminal, and no open ports thanks to Cloudflare Tunnel.

---

## Table of contents

1. [What it does](#what-it-does)
2. [How it fits together](#how-it-fits-together)
3. [Roles](#roles)
4. [Initial setup](#initial-setup) — fresh Linux box to working dashboard
5. [Adding a new Minecraft server](#adding-a-new-minecraft-server) — the part you'll do most often
6. [Day-to-day use](#day-to-day-use)
7. [Troubleshooting](#troubleshooting)
8. [Security notes](#security-notes)
9. [What's not included](#whats-not-included)

---

## What it does

- Start, stop, and restart Minecraft servers from a web page
- Manage whitelist entries via RCON
- Send arbitrary console commands via RCON
- Browse and edit text files inside each server's folder (sandboxed)
- Manage dashboard users with per-server roles
- Open a real bash shell in your browser (super-operators only)
- Log every state change to an audit table

---

## How it fits together

```
            https://dash.YOUR_DOMAIN_NAME.com
                       │
              Cloudflare Tunnel
                       │
      ┌────────────────▼────────────────┐
      │   dashboard (Node + Fastify)    │
      │   listens on 127.0.0.1:8080     │
      ├─────────────────────────────────┤
      │   /api/*            api routes  │
      │   /terminal/*       ttyd proxy  │
      │   /                 static html │
      └────────┬───────────────┬────────┘
               │               │
       systemctl --user      RCON :2557x
               │               │
               ▼               ▼
       ┌──────────────────────────┐
       │   Minecraft servers      │
       │   (one systemd service   │
       │   per server)            │
       └──────────────────────────┘
```

Three pieces run as **user-level systemd services** on the same Linux box:

| Service | What it is |
| --- | --- |
| `dashboard` | The web UI and API |
| `cloudflared` | The Cloudflare Tunnel that exposes the dashboard |
| `ttyd` | The web terminal (only if you enable it) |
| `mc-<name>` | One per Minecraft server |

Nothing listens on a public port. Cloudflare reaches the dashboard outbound.

---

## Roles

Every user has either:

- **No access** to a server, or
- **starter** — can only press *Start*
- **operator** — can do everything on that server (stop, restart, whitelist, console, files)

Plus a global flag:

- **super-operator** — can do everything on every server, plus manage users and use the in-browser terminal

Role checks happen server-side on every request. The frontend hiding buttons is only UX.

---

# Initial setup

This is what you do once, on a fresh Linux box. Adding more servers later is in the [next section](#adding-a-new-minecraft-server).

## 1. Install system packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git openjdk-21-jre-headless sqlite3 build-essential

# Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

node --version    # must be v20.x or higher
```

`build-essential` is needed because two npm packages (`argon2`, `better-sqlite3`) compile native code on install.

## 2. Enable user-level services

User services run as your normal user, not root. They need lingering enabled so they keep running after you log out:

```bash
sudo loginctl enable-linger $USER
```

## 3. Set up the dashboard

```bash
sudo mkdir -p /srv/dashboard
sudo chown -R $USER:$USER /srv/dashboard
cd /srv/dashboard

# Drop the dashboard files in here.
# Either: git clone https://github.com/b3dag/mcdashboard .
# Or:     unzip the release archive into the current directory.

npm install
```

If `npm install` fails with errors about `gyp` or Python, you forgot `build-essential`. Install it and rerun.

## 4. Configure

```bash
cp .env.example .env

# Generate a session secret — copy the output
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

nano .env
```

In `.env`, set:

| Variable | What to put |
| --- | --- |
| `SESSION_SECRET` | The random string you just generated |
| `RCON_PASSWORD_VANILLA` | The RCON password from your first server's `server.properties` (set this in step 6) |
| `TERMINAL_ENABLED` | `true` if you want the in-browser bash shell, otherwise leave unset |

Don't touch `HOST` — it should stay `127.0.0.1`.

## 5. Create your first super-operator

The first user must be created from the command line — there's no signup form (on purpose).

```bash
node scripts/create-user.js mael --super
```

You'll be prompted for a password (12 character minimum). After this user exists, you can create more users from inside the dashboard.

> **Forgot the password?** No reset email — just delete and recreate:
> ```bash
> sqlite3 data/dashboard.db "DELETE FROM users WHERE username = 'mael';"
> node scripts/create-user.js mael --super
> ```

## 6. Run the dashboard as a service

```bash
mkdir -p ~/.config/systemd/user
cp /srv/dashboard/systemd/dashboard.service ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now dashboard
systemctl --user status dashboard
```

It should say `active (running)` and listen on `127.0.0.1:8080`.

## 7. Set up Cloudflare Tunnel

Install cloudflared:

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
```

Authenticate, create a tunnel, and route DNS:

```bash
cloudflared tunnel login                                       # opens a URL — log in via browser
cloudflared tunnel create YOUR_DOMAIN_NAME-dash                       # note the tunnel ID it prints
cloudflared tunnel route dns YOUR_DOMAIN_NAME-dash dash.YOUR_DOMAIN_NAME.com
```

Create the tunnel config — replace `<tunnel-id>` with the ID from above:

```bash
mkdir -p ~/.cloudflared
nano ~/.cloudflared/config.yml
```

```yaml
tunnel: <tunnel-id>
credentials-file: /home/admi/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: dash.YOUR_DOMAIN_NAME.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

Run cloudflared as a service:

```bash
cp /srv/dashboard/systemd/cloudflared.service ~/.config/systemd/user/
nano ~/.config/systemd/user/cloudflared.service
# Edit ExecStart to:
#     /usr/bin/cloudflared tunnel run YOUR_DOMAIN_NAME-dash

systemctl --user daemon-reload
systemctl --user enable --now cloudflared
systemctl --user status cloudflared
```

Visit `https://dash.YOUR_DOMAIN_NAME.com`. You should see the login page.

## 8. (Optional) In-browser terminal

The dashboard can proxy a real bash shell at `/terminal.html`, gated to super-operators only.

Install ttyd from GitHub (it's not in Debian repos):

```bash
curl -L https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64 -o /tmp/ttyd
sudo mv /tmp/ttyd /usr/local/bin/ttyd
sudo chmod +x /usr/local/bin/ttyd
ttyd --version
```

Run it as a service:

```bash
cp /srv/dashboard/systemd/ttyd.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ttyd
systemctl --user status ttyd
```

Enable the proxy in the dashboard:

```bash
echo "TERMINAL_ENABLED=true" >> /srv/dashboard/.env
systemctl --user restart dashboard
```

Visit `https://dash.YOUR_DOMAIN_NAME.com/terminal.html` — you should get a bash shell.

---

You now have a working dashboard with no servers in it yet. Move on to [Adding a new Minecraft server](#adding-a-new-minecraft-server) to add your first one.

---

# Adding a new Minecraft server

This is the workflow you run **every time you add a server** — both for your first one after initial setup, and for any additional ones later. There are **four files** to touch and **three commands** to run.

We'll set up a server called `creative01` as the example. Substitute your own name throughout.

## Naming rules

The `name` you pick has to be:

- Lowercase only
- Letters `a-z`, digits `0-9`, hyphens `-`
- Used in URLs and folder paths, so keep it short

Good: `vanilla`, `creative01`, `create-astral`, `mc-modded-2`
Bad: `Creative 01`, `Vanilla!`, `CREATIVE`

## Step 1 — Create the server folder and download the jar

```bash
sudo mkdir -p /srv/mcserv
sudo chown -R $USER:$USER /srv/mcserv
cd /srv/mcserv
mkdir creative01
cd creative01
```

For **vanilla Minecraft**:
```bash
wget https://piston-data.mojang.com/v1/objects/<HASH>/server.jar -O server.jar
# Get the latest URL from https://www.minecraft.net/en-us/download/server
```

For **Fabric**:
```bash
wget https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar -O fabric-installer.jar
java -jar fabric-installer.jar server -mcversion 1.20.4 -downloadMinecraft
# Produces fabric-server-launch.jar
```

For **Paper, Forge, NeoForge, Quilt**: download from their respective websites. The dashboard doesn't care which mod loader you use — it only needs to know how to start it.

Accept the EULA:
```bash
echo "eula=true" > eula.txt
```

## Step 2 — Generate `server.properties` and configure RCON

Start the server once to generate config files, then stop it:

```bash
java -Xmx2G -jar server.jar nogui    # use fabric-server-launch.jar for Fabric
# Wait for "Done" in the log, then Ctrl+C
```

Edit `server.properties`:

```bash
nano server.properties
```

Find and change these lines:

```properties
enable-rcon=true
rcon.port=25576
rcon.password=YOUR_LONG_RANDOM_PASSWORD_HERE
white-list=true
server-port=25566
```

> **Important:** every server you add needs a **unique RCON port** (25575, 25576, 25577, …) and a **unique server port** (25565, 25566, …). Otherwise they'll collide.
>
> Generate a strong RCON password:
> ```bash
> openssl rand -hex 24
> ```

## Step 3 — Create the systemd unit

```bash
mkdir -p ~/.config/systemd/user      # sometimes this folder doesn't exist yet
cp /srv/dashboard/systemd/mc-vanilla.service ~/.config/systemd/user/mc-creative01.service
nano ~/.config/systemd/user/mc-creative01.service
```

Edit the file. The two lines that matter:

```ini
WorkingDirectory=/srv/mcserv/creative01
ExecStart=/usr/bin/java -Xms2G -Xmx4G -jar server.jar nogui
```

> Use `fabric-server-launch.jar` if it's a Fabric server, or whatever the loader's launch jar is called.
>
> Adjust the memory (`-Xms` minimum, `-Xmx` maximum). 4G is fine for vanilla, modpacks often want 6–8G.

Reload and enable:

```bash
systemctl --user daemon-reload
systemctl --user enable mc-creative01
```

(Don't start it yet — we'll do that from the dashboard once it's registered.)

## Step 4 — Add the RCON password to `.env`

```bash
nano /srv/dashboard/.env
```

Add a line:

```
RCON_PASSWORD_CREATIVE01=YOUR_LONG_RANDOM_PASSWORD_HERE
```

> The variable name must:
> - Start with `RCON_PASSWORD_`
> - Be **all uppercase**
> - Match (case-insensitively) the server name with hyphens replaced by underscores
>
> Examples:
> - server `vanilla` → `RCON_PASSWORD_VANILLA`
> - server `creative01` → `RCON_PASSWORD_CREATIVE01`
> - server `create-astral` → `RCON_PASSWORD_CREATE_ASTRAL`
>
> The password must exactly match what you wrote in `server.properties`.

## Step 5 — Register the server in `servers.json`

This is the file that tells the dashboard your server exists.

```bash
nano /srv/dashboard/servers.json
```

Replace the contents with one entry per server. For our `creative01` example:

```json
{
  "_comment": "Registry of Minecraft servers managed by the dashboard.",
  "servers": [
    {
      "name": "creative01",
      "display_name": "Creative",
      "folder": "/srv/mcserv/creative01",
      "systemd_unit": "mc-creative01.service",
      "rcon": {
        "host": "127.0.0.1",
        "port": 25576,
        "password_env": "RCON_PASSWORD_CREATIVE01"
      }
    }
  ]
}
```

What each field does:

| Field | What it means |
| --- | --- |
| `name` | The URL-safe identifier. Used in `/server.html?name=…` and permission entries. |
| `display_name` | What shows up in the UI. Can have spaces and capitals. |
| `folder` | Absolute path to the server's directory on disk. |
| `systemd_unit` | The exact filename (with `.service`) you put in `~/.config/systemd/user/`. |
| `rcon.host` | Always `127.0.0.1` — RCON listens locally on the same machine. |
| `rcon.port` | Must match `rcon.port` in `server.properties`. **Unique per server.** |
| `rcon.password_env` | The env variable name in `.env` that holds the RCON password. |

> **Validate the JSON before saving.** A missing comma or extra brace will keep the dashboard from starting. Quick check:
> ```bash
> node -e "JSON.parse(require('fs').readFileSync('/srv/dashboard/servers.json'))" && echo OK
> ```

> **Adding a second, third, fourth server later?** Just add another object to the `servers` array. **Don't forget the comma** between entries:
> ```json
> "servers": [
>   { "name": "creative01", ... },
>   { "name": "survival02", ... },
>   { "name": "modded03",   ... }
> ]
> ```
> Each entry needs its own folder, unique server port, unique RCON port, unique RCON password, and matching `RCON_PASSWORD_<NAME>` in `.env`.

## Step 6 — Restart the dashboard and grant access

```bash
systemctl --user restart dashboard
```

Then in your browser:

1. Log in to `https://dash.YOUR_DOMAIN_NAME.com` as a super-operator.
2. Go to **users**.
3. Find your own user, set the role for `creative01` to **operator** (or **starter**, or leave blank for no access).
4. Repeat for any other users you want to give access to.

> Super-operators automatically have access to every server — they don't need explicit roles.

## Step 7 — Start it from the dashboard

Go to **servers**, find your new server, click **start**.

If anything goes wrong, check the logs:

```bash
journalctl --user -u mc-creative01 --no-pager -n 50
journalctl --user -u dashboard --no-pager -n 30
```

## Quick checklist

When adding a new server, you've touched:

- [ ] Created `/srv/mcserv/<name>/` with a working server jar
- [ ] Set RCON in `server.properties` (unique port, strong password, `enable-rcon=true`)
- [ ] Created `~/.config/systemd/user/mc-<name>.service` with correct paths
- [ ] Added `RCON_PASSWORD_<NAME>=...` to `/srv/dashboard/.env`
- [ ] Added a JSON entry in `/srv/dashboard/servers.json`
- [ ] Ran `systemctl --user daemon-reload`
- [ ] Ran `systemctl --user restart dashboard`
- [ ] Granted yourself a role on the new server in the **users** page

---

# Day-to-day use

## Adding a new dashboard user

1. Log in as super-operator
2. **users** page → fill in username and password (12+ chars) → **create**
3. Use the per-server dropdowns to set their roles

## Resetting someone's password

As super-op on the **users** page, click **reset password** next to their name. Their session is force-logged-out.

## Granting yourself another super-op (CLI fallback)

If you only have shell access:

```bash
cd /srv/dashboard
node scripts/create-user.js friend --super
```

## Viewing the audit log

Every state change is logged. Quickest way to read it:

```bash
sqlite3 /srv/dashboard/data/dashboard.db \
  "SELECT datetime(ts/1000,'unixepoch'), username, action, target FROM audit_log ORDER BY ts DESC LIMIT 50;"
```

Or via API (super-only):

```
GET https://dash.YOUR_DOMAIN_NAME.com/api/audit?limit=200
```

## Updating the dashboard code

```bash
cd /srv/dashboard
git pull              # if you cloned from git
npm install           # picks up dependency changes
systemctl --user restart dashboard
```

The SQLite database is preserved across restarts — users, sessions, audit log all survive.

## Backups

Back up regularly:

| What | Why |
| --- | --- |
| `/srv/dashboard/data/dashboard.db` | Users, audit log |
| `/srv/dashboard/.env` | All secrets |
| `/srv/dashboard/servers.json` | Server registry |
| `/srv/mcserv/*/world/` | Your worlds |
| `/srv/mcserv/*/whitelist.json`, `ops.json`, `banned-players.json` | MC permissions |

Quick snapshot:

```bash
tar czf /backup/dashboard-$(date +%Y%m%d).tar.gz \
  /srv/dashboard/data /srv/dashboard/.env /srv/dashboard/servers.json
tar czf /backup/mc-$(date +%Y%m%d).tar.gz /srv/mcserv
```

Hook this into a cron job or a systemd timer.

---

# Troubleshooting

### Dashboard won't start

Check the logs:
```bash
journalctl --user -u dashboard --no-pager -n 50
```

| Error | Fix |
| --- | --- |
| `SESSION_SECRET is required` | You forgot to set it in `.env` |
| `unable to determine transport target for "pino-pretty"` | You're on an old `server.js`. The current one doesn't use pino-pretty. |
| `expected '4.x' fastify version` | Old plugin version. Run `npm install @fastify/static@latest @fastify/cookie@latest @fastify/http-proxy@latest` |
| Crashes silently | `npm install` may have failed natively. Run it again with `build-essential` installed. |

### Pressing Start gives an error

Check what the systemd unit is doing:
```bash
journalctl --user -u mc-<name> --no-pager -n 50
```

| Symptom | Cause |
| --- | --- |
| `code=exited, status=203/EXEC` | Wrong path in `ExecStart`. Common: `/usr/bin/ttyd` vs `/usr/local/bin/ttyd`. |
| Java not found | `sudo apt install openjdk-21-jre-headless` |
| Port already in use | Another server is using the same port. Change `server-port` in `server.properties`. |
| Dashboard returns "bad request" / 400 | Browser cache of old `app.js`. Hard refresh (Ctrl+Shift+R). |

### Whitelist or console returns "rcon connect failed"

- Server isn't running yet → start it first
- RCON not enabled → check `enable-rcon=true` in `server.properties`
- Wrong password → make sure `.env` matches `server.properties` exactly
- Wrong port → make sure `servers.json` `rcon.port` matches `server.properties` `rcon.port`

After fixing `.env` or `servers.json`:
```bash
systemctl --user restart dashboard
```

After fixing `server.properties`, restart the MC server too.

### Terminal page shows "ECONNREFUSED 127.0.0.1:7681"

ttyd isn't running:
```bash
systemctl --user status ttyd
```

If it's failing with `203/EXEC`, the unit file probably points at `/usr/bin/ttyd` — fix it to `/usr/local/bin/ttyd` and reload.

### Can't type in the terminal

ttyd defaults to read-only. The unit file should have `--writable`:
```
ExecStart=/usr/local/bin/ttyd --port 7681 --interface 127.0.0.1 --writable bash
```

### Cloudflare Tunnel won't connect

```bash
journalctl --user -u cloudflared --no-pager -n 50
```

The tunnel ID in `~/.cloudflared/config.yml` must match the one created with `cloudflared tunnel create`. The `credentials-file` path must point at the JSON file that was generated.

### "loginctl enable-linger" gives "Access denied"

Use `sudo`:
```bash
sudo loginctl enable-linger $USER
```

---

# Security notes

- **Backend binds to 127.0.0.1.** Never set `HOST=0.0.0.0`.
- **Every state-changing endpoint re-checks the role server-side.** Frontend hiding is just UX.
- **File paths from operators are sandboxed** against the server's folder root. The check is in `servers.js` — it's the most security-sensitive piece of code in the project.
- **`is_super` should only be granted to people you fully trust.** Supers can change other users' passwords, access every server, and (if enabled) get a bash shell.
- **The `/terminal` proxy is full root-equivalent inside the dashboard user's account.** Treat super-op like SSH.
- **RCON passwords in `.env` should be long and unique per server.**
- **Run the dashboard as a non-root user.** The example uses `admi`. Don't run anything in this stack as root.
- **Cloudflare Tunnel credentials are sensitive** — they're effectively a router for your subdomain. Keep `~/.cloudflared/*.json` private.

---

# What's not included

Things you might want to add later:

- 2FA (TOTP) for login
- Live log streaming (Server-Sent Events tailing `journalctl -fu mc-<name>`)
- File uploads (e.g. replacing jars or uploading mods)
- Email-based password reset
- Automated backups

The architecture supports adding any of these without major rework.

---

# License

Personal project. Adapt freely.
