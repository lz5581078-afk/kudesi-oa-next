#!/bin/bash
# Run once as root from a reviewed checkout, with a PUBLIC ed25519 key file.
set -euo pipefail
[[ $(id -u) == 0 && $# == 1 ]] || { echo 'Usage: sudo bash install-controller.sh <public-key-file>'; exit 64; }
root=/srv/kudesi-lc
source_dir=$(cd "$(dirname "$0")" && pwd)
public_key=$(cat "$1")
[[ "$public_key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [A-Za-z0-9@._-]+)?$ ]] || { echo 'Expected a public ed25519 key'; exit 64; }
getent passwd lcdeploy >/dev/null || useradd --create-home --shell /bin/bash lcdeploy
usermod --password '*' lcdeploy
install -d -m 755 /usr/local/lib/kudesi-lc /usr/local/libexec "$root/control"
install -m 755 "$source_dir/release.sh" "$source_dir/release.py" /usr/local/lib/kudesi-lc/
install -m 755 "$source_dir/ssh-gateway.sh" /usr/local/libexec/kudesi-lc-ssh
install -m 644 "$source_dir/Dockerfile" "$source_dir/compose.yml" "$root/control/"
cat > /usr/local/sbin/kudesi-lc-command <<'WRAPPER'
#!/bin/sh
exec /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8 /bin/bash /usr/local/lib/kudesi-lc/release.sh "$@"
WRAPPER
chmod 755 /usr/local/sbin/kudesi-lc-command
printf 'lcdeploy ALL=(root) NOPASSWD: /usr/local/sbin/kudesi-lc-command\n' > /etc/sudoers.d/kudesi-lc
chmod 440 /etc/sudoers.d/kudesi-lc
visudo -cf /etc/sudoers.d/kudesi-lc
install -d -o lcdeploy -g lcdeploy -m 700 /home/lcdeploy/.ssh
printf 'restrict,command="/usr/local/libexec/kudesi-lc-ssh" %s\n' "$public_key" > /home/lcdeploy/.ssh/authorized_keys
chown root:root /home/lcdeploy/.ssh/authorized_keys
chmod 644 /home/lcdeploy/.ssh/authorized_keys
# Keep the account unable to replace its forced-command authorization.
chown root:root /home/lcdeploy /home/lcdeploy/.ssh
chmod 755 /home/lcdeploy
chmod 755 /home/lcdeploy/.ssh
current=$(readlink -f "$root/current")
[[ "$current" == "$root/releases/"* ]] || exit 1
if [[ ! -e "$current/image.env" ]]; then
 image=$(docker inspect --format '{{.Config.Image}}' kudesi-lc-api-1)
 [[ "$image" =~ ^kudesi-lc-api:[a-z0-9-]+$ ]] || exit 1
 printf 'KUDESI_API_IMAGE=%s\n' "$image" > "$current/image.env"
fi
# Public version metadata is safe to serve and enables end-to-end release checks.
install -m 644 "$current/release.json" "$current/apps/web/dist/release.json"
echo 'Restricted deployment controller installed; shared configuration preserved.'
