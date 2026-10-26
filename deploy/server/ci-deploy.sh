#!/bin/bash
# Secret values come only from Actions environment; no password authentication is used.
set -euo pipefail
: "${DEPLOY_HOST:?Missing DEPLOY_HOST}" "${DEPLOY_USER:?Missing DEPLOY_USER}" "${DEPLOY_SSH_KEY:?Missing DEPLOY_SSH_KEY}" "${DEPLOY_KNOWN_HOSTS:?Missing DEPLOY_KNOWN_HOSTS}"
[[ "$DEPLOY_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ && "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || exit 64
mode=${1:-}
release=${2:-}
[[ "$release" =~ ^[0-9]{8}-[a-z0-9-]{1,60}$ ]] || exit 64
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"
printf '%s\n' "$DEPLOY_SSH_KEY" > "$work/key"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$work/known_hosts"
chmod 600 "$work/key" "$work/known_hosts"
unset DEPLOY_SSH_KEY DEPLOY_KNOWN_HOSTS
ssh-keygen -y -f "$work/key" >/dev/null
options=(-i "$work/key" -o IdentitiesOnly=yes -o BatchMode=yes -o PasswordAuthentication=no -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$work/known_hosts" -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=4)
remote() { ssh "${options[@]}" "$DEPLOY_USER@$DEPLOY_HOST" "$1"; }
if [[ "$mode" == rollback ]]; then
 remote "rollback $release"
elif [[ "$mode" == deploy && $# == 4 ]]; then
 archive=$3
 revision=$4
 [[ "$revision" =~ ^[a-f0-9]{40}([a-f0-9]{24})?$ && -f "$archive" ]] || exit 64
 digest=$(sha256sum "$archive" | cut -d' ' -f1)
 remote "upload $release $digest" < "$archive"
 remote "deploy $release"
else
 exit 64
fi
# If public verification fails, restore only the release this invocation deployed.
if ! python3 - "$release" "${revision:-}" <<'PY'
import json,sys,time,urllib.request
for attempt in range(6):
 try:
  with urllib.request.urlopen('https://lc.kudesi.com/api/health',timeout=15) as f:health=json.load(f)
  with urllib.request.urlopen('https://lc.kudesi.com/release.json?verify='+sys.argv[1],timeout=15) as f:release=json.load(f)
  if health.get('status')=='ok' and release.get('release')==sys.argv[1] and (not sys.argv[2] or release.get('revision')==sys.argv[2]):break
 except Exception:pass
 time.sleep(3)
else:raise SystemExit('Public health or release verification failed')
print('Public HTTPS health and release verification passed')
PY
then
 if [[ "$mode" == deploy ]]; then remote "rollback-if-current $release"; fi
 exit 1
fi
