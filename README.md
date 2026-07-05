# QNAP Dashboard Proxy — GitHub + Portainer (build) version

Deployed via Portainer's **Repository** stack method (real `docker build`, no
npm-on-every-restart) with credentials read from a single `.env` file that
lives on the QNAP's disk -- not typed into Portainer's UI one variable at a
time, and not committed to GitHub either.

## Files to upload to GitHub (5 files -- no secrets in any of them)

- `server.js`
- `package.json`
- `Dockerfile`
- `docker-compose.yml`
- `.gitignore`

`server.js` only reads credentials via `process.env.X` -- none are hardcoded,
so these 5 files are safe to put in a repo, public or private.

**Do NOT upload `.env`** to GitHub. It stays on the NAS only (step 2 below).

## Steps

### 1. Create the GitHub repo and upload the 5 files
github.com -> **New repository** -> name it, e.g., `qnap-dashboard-proxy` ->
**Add file -> Upload files** -> drag in the 5 files listed above -> Commit.

### 2. Put `.env` directly on the QNAP (this is the one-time-only step --
no more re-entering variables after this)

Using File Station, create this folder if it doesn't already exist:
```
/Container/qnap-dashboard-proxy/
```
Upload the `.env` file (included in this download) into it. Open it first and
fill in `QNAP_HOST` and the other `<your QNAP LAN IP>`-style placeholders if
you haven't already.

Then confirm the *real* host path (right-click -> Properties in File Station,
or check which volume it's under) -- it's usually:
```
/share/CACHEDEV1_DATA/Container/qnap-dashboard-proxy
```
but may differ (e.g. `CACHEDEV2_DATA`) depending on your storage pool setup.

### 3. Match that path in `docker-compose.yml`
Open `docker-compose.yml` and confirm the `env_file:` line matches your actual
path from step 2:
```yaml
env_file:
  - /share/CACHEDEV1_DATA/Container/qnap-dashboard-proxy/.env
```

### 4. Create the stack in Portainer
1. **Stacks -> Add stack**, name it `qnap-dashboard-proxy`
2. Build method: **Repository**
3. Repository URL: `https://github.com/<your-username>/qnap-dashboard-proxy`
4. Repository reference: `refs/heads/main` (or `master`)
5. Compose path: `docker-compose.yml`
6. If the repo is Private, fill in your GitHub username + a Personal Access
   Token (GitHub -> Settings -> Developer settings -> Personal access tokens ->
   generate one with the `repo` scope). Simplest alternative: make the repo
   Public instead -- nothing sensitive is in it, so no real downside.
7. **Skip the Environment variables section entirely** -- `.env` on disk
   handles all of that now
8. **Deploy the stack**

### 5. Updating credentials later
Just edit the `.env` file directly on the NAS (File Station or SSH) and
restart the container in Portainer -- no need to touch the stack config again.

### 6. Updating the code later
Edit `server.js`, push the change to GitHub, then use Portainer's
**Pull and redeploy** on the stack to rebuild with the new code.

### 7. Verify
`http://<QNAP_IP>:9999/health` should return `{"status":"ok"}`.

## If you'd rather not deal with host file paths at all

Portainer also has a bulk-paste option for environment variables on the stack
form -- usually a small "Advanced mode" toggle near the Environment variables
section that lets you paste a whole block of `KEY=VALUE` lines at once instead
of adding rows one by one. If your Portainer version has it, you can just
paste the entire contents of `.env` there in one shot instead of doing the
file-path setup above. Whichever's less friction for you.
