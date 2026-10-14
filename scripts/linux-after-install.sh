#!/bin/sh
set -eu

# A system-installed, root-owned helper allows Electron to sandbox renderers
# without an AppArmor exemption or a --no-sandbox launcher.
install_dir='/opt/${sanitizedProductName}'
helper="$install_dir/chrome-sandbox"
test "$(id -u)" = 0
test -d "$install_dir"
test ! -L "$install_dir"
test -f "$helper"
test ! -L "$helper"
test "$(stat -c '%u:%g' "$install_dir")" = '0:0'
test -z "$(find "$install_dir" \( ! -user root -o ! -group root \) -print -quit)"
# fpm preserves build-host umask (often 002); normalize the trusted tree before
# enabling SUID. find does not follow packaged symlinks.
find "$install_dir" \( -type d -o -type f \) -exec chmod go-w {} +
test -z "$(find "$install_dir" -type d -perm /022 -print -quit)"
chown root:root "$helper"
chmod 4755 "$helper"

if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --install '/usr/bin/${executable}' '${executable}' "$install_dir/${executable}" 100
else
  ln -sf "$install_dir/${executable}" '/usr/bin/${executable}'
fi

if command -v update-mime-database >/dev/null 2>&1; then
  update-mime-database /usr/share/mime || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications || true
fi
