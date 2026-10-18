# Deploying on AWS EC2

The live site: **https://handcricket-prathi.duckdns.org**

## What's set up

| Piece | Details |
|---|---|
| Server | EC2 t3.micro, Mumbai (ap-south-1), Ubuntu 26.04, 1 GB swap |
| Address | Elastic IP `15.206.101.123`; DuckDNS name `handcricket-prathi.duckdns.org` points at it |
| App | `~/hand-cricket`, Node 22, started by PM2 as **`hand-cricket`** (`npm start` → `node --env-file-if-exists=.env server.js`) on `127.0.0.1:3000` |
| Start on boot | PM2 saved process list + systemd unit `pm2-ubuntu` (enabled) |
| Web server | Nginx site `/etc/nginx/sites-available/hand-cricket` (the default site is removed). Proxies to port 3000; `/socket.io/` gets the WebSocket upgrade headers and 1-hour read/send timeouts |
| HTTPS | Let's Encrypt certificate via `certbot --nginx`; HTTP → HTTPS redirect (301). Auto-renewed by the `certbot.timer` systemd timer (dry run passed) |
| Secrets | `~/hand-cricket/.env`, mode `600`, with `NODE_ENV=production`, `PORT=3000`, TURN and Supabase keys. Never committed; never printed |
| Health check | `GET /health` → `{"ok":true}` |

In production (`NODE_ENV=production`), dev mode (keyboard numbers) is off.

## Connect

```bash
ssh -i ~/.ssh/backend-server-key.pem ubuntu@15.206.101.123
```

If SSH times out, your home IP has probably changed. Update the SSH rule in the EC2 security group to your new IP (`/32`). **Never open SSH to `0.0.0.0/0`.**

## Redeploy (after pushing to GitHub)

```bash
cd ~/hand-cricket
git pull
npm ci --omit=dev
pm2 reload hand-cricket
curl -s localhost:3000/health   # → {"ok":true}
```

**Changing a secret:**
1. `nano ~/hand-cricket/.env`
2. `pm2 restart hand-cricket --update-env`

**Supabase:**
- `SUPABASE_URL` must be the **API URL**, `https://<project-ref>.supabase.co`, not the dashboard page address.
- The tables come from `supabase/schema.sql`, run once in the Supabase SQL Editor.

## Logs and status

```bash
pm2 status                                   # is it online? how many restarts?
pm2 logs hand-cricket --lines 100            # app output + errors (Ctrl+C to stop)
pm2 logs hand-cricket --err --lines 50 --nostream
sudo tail -n 50 /var/log/nginx/error.log     # proxy errors (e.g. 502 when the app is down)
sudo systemctl status nginx
sudo certbot certificates                    # certificate expiry date
```

## Quick checks from anywhere

```bash
curl -s https://handcricket-prathi.duckdns.org/health                  # {"ok":true}
curl -sI http://handcricket-prathi.duckdns.org | head -1               # 301 → HTTPS
curl -s -H "x-player-id: $(uuidgen | tr A-Z a-z)" \
  https://handcricket-prathi.duckdns.org/api/me/groups                 # {"ok":true,"groups":[]} once Supabase is set up
```

## When something breaks

| Symptom | Likely cause | Fix |
|---|---|---|
| SSH times out | Your IP changed | Update the security group SSH rule to your IP `/32` |
| `502 Bad Gateway` | App not running | `pm2 status`, `pm2 logs hand-cricket --err`, then `pm2 restart hand-cricket` |
| "Groups are offline" (503 on `/api/...`) | Supabase URL, key or tables | `pm2 logs hand-cricket --err` shows the Supabase message |
| Calls don't connect between some networks | TURN missing or wrong | Check the `TURN_*` values in `.env`, then `pm2 restart hand-cricket --update-env` |
| Certificate warning | Renewal failed | `sudo certbot renew --dry-run`, `systemctl list-timers \| grep certbot` |

## Cost checklist

Check these in the AWS Billing console; prices change, so treat the notes as a guide.

- [ ] **EC2 t3.micro:** covered by the Free Tier only while your account's free period lasts; after that it's billed per hour.
- [ ] **Public IPv4 / Elastic IP:** AWS charges per hour for every public IPv4 address, even when it's attached.
- [ ] **EBS volume:** billed per GB-month for the root disk. Delete old snapshots you don't need.
- [ ] **Data transfer out:** small here, because video goes browser-to-browser. Only signaling and page loads leave this server. TURN relay traffic is billed by your TURN provider, not AWS.
- [ ] **A billing alarm or AWS Budget** (e.g. $5/month), so a surprise shows up in your inbox.
- [ ] **Render is still running.** Switch it off once you're happy with AWS, so you don't pay for both.
- [ ] **Nothing else running by accident:** check the EC2 console for extra instances, volumes or Elastic IPs in *every* region you've used.

## Security notes

- Only ports **80 and 443** need to be open to everyone; **22 (SSH) only to your IP**.
- `.env` stays mode `600` and outside git. The Supabase service key is used only by the server.
- A backup `~/hand-cricket/.env.bak` (mode `600`) was made while fixing `SUPABASE_URL`. Delete it once everything works: `rm ~/hand-cricket/.env.bak`.
- **Let's Encrypt has no email on file,** so there won't be expiry warning emails (auto-renewal still runs). To add one: `sudo certbot update_account --email you@example.com`.
