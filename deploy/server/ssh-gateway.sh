#!/bin/bash
set -euo pipefail
command=${SSH_ORIGINAL_COMMAND:-}
[[ -n "$command" && "$command" != *$'\n'* && "$command" != *$'\r'* ]] || exit 64
read -r -a args <<< "$command"
valid_id() { [[ "$1" =~ ^[0-9]{8}-[a-z0-9-]{1,60}$ ]]; }
case "${args[0]:-}" in
  upload) [[ ${#args[@]} == 3 ]] && valid_id "${args[1]}" && [[ "${args[2]}" =~ ^[a-f0-9]{64}$ ]] || exit 64 ;;
  deploy|rollback|rollback-if-current) [[ ${#args[@]} == 2 ]] && valid_id "${args[1]}" || exit 64 ;;
  status) [[ ${#args[@]} == 1 ]] || exit 64 ;;
  *) exit 64 ;;
esac
exec /usr/bin/sudo -n /usr/local/sbin/kudesi-lc-command "${args[@]}"
