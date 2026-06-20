#!/usr/bin/env bash
# Check that local, GitHub, and VPS are all on the same commit.
# Run at the start of any session before writing code.
set -euo pipefail

VPS="${VPS:-root@178.104.235.142}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=5)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOCAL="$(git rev-parse HEAD 2>/dev/null || echo 'not-a-git-repo')"
LOCAL_SHORT="${LOCAL:0:7}"

GITHUB="$(git ls-remote origin HEAD 2>/dev/null | awk '{print $1}' || echo 'unreachable')"
GITHUB_SHORT="${GITHUB:0:7}"

VPS_REV="$(ssh "${SSH_OPTS[@]}" "$VPS" "cat /app/.deployed-revision 2>/dev/null || echo missing" 2>/dev/null || echo 'unreachable')"
VPS_SHORT="${VPS_REV:0:7}"

LOCAL_MSG="$(git log -1 --format='%s' 2>/dev/null || echo '')"

echo ""
echo "McLellan Hub — sync check"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
printf "  Local   %s  %s\n" "$LOCAL_SHORT" "$LOCAL_MSG"
printf "  GitHub  %s\n" "$GITHUB_SHORT"
printf "  VPS     %s\n" "$VPS_SHORT"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

DRIFT=0
if [[ "$LOCAL" != "$GITHUB" && "$GITHUB" != "unreachable" ]]; then
  echo "  ⚠ Local and GitHub differ — push or pull before deploying."
  DRIFT=1
fi
if [[ "$LOCAL" != "$VPS_REV" && "$VPS_REV" != "unreachable" && "$VPS_REV" != "missing" ]]; then
  echo "  ⚠ VPS is not on the local commit — run scripts/deploy.sh."
  DRIFT=1
fi
if [[ "$DRIFT" -eq 0 ]]; then
  echo "  ✓ All in sync."
fi
echo ""
