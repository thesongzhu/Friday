#!/usr/bin/env bash
# build-friday-linux-packages.sh — build .deb and AppImage directory artifacts.
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# ─── Read version from package.json ───

FRIDAY_VERSION="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('${REPO_ROOT}/package.json','utf8')).version)")"
echo "Building Linux packages for Friday v${FRIDAY_VERSION}"

DIST_DIR="${REPO_ROOT}/dist"
mkdir -p "${DIST_DIR}"

# ─── Build .deb package ───

DEB_STAGING="${DIST_DIR}/deb-staging"
rm -rf "${DEB_STAGING}"
mkdir -p "${DEB_STAGING}/DEBIAN"
mkdir -p "${DEB_STAGING}/usr/lib/friday/bin"
mkdir -p "${DEB_STAGING}/usr/share/applications"

# Copy control files and substitute version.
sed "s/^Version:.*/Version: ${FRIDAY_VERSION}/" \
  "${REPO_ROOT}/packaging/linux/deb/DEBIAN/control" \
  > "${DEB_STAGING}/DEBIAN/control"

cp "${REPO_ROOT}/packaging/linux/deb/DEBIAN/postinst" "${DEB_STAGING}/DEBIAN/postinst"
cp "${REPO_ROOT}/packaging/linux/deb/DEBIAN/prerm"    "${DEB_STAGING}/DEBIAN/prerm"

chmod 0755 "${DEB_STAGING}/DEBIAN/postinst"
chmod 0755 "${DEB_STAGING}/DEBIAN/prerm"

# Copy the built Friday runtime into the package tree.
# Assumes `npm run build` has already been run and output lives in dist/friday-runtime.
if [ -d "${DIST_DIR}/friday-runtime" ]; then
  cp -a "${DIST_DIR}/friday-runtime/." "${DEB_STAGING}/usr/lib/friday/"
else
  echo "Warning: dist/friday-runtime not found — .deb will contain packaging metadata only."
fi

DEB_OUT="${DIST_DIR}/friday_${FRIDAY_VERSION}_amd64.deb"
dpkg-deb --root-owner-group --build "${DEB_STAGING}" "${DEB_OUT}" 2>/dev/null || \
  dpkg-deb --build "${DEB_STAGING}" "${DEB_OUT}"

echo "Built .deb: ${DEB_OUT}"

# ─── Build AppImage directory ───

APPIMAGE_STAGING="${DIST_DIR}/Friday-x86_64.AppDir"
rm -rf "${APPIMAGE_STAGING}"
mkdir -p "${APPIMAGE_STAGING}/usr/bin"
mkdir -p "${APPIMAGE_STAGING}/usr/share/icons/hicolor/256x256/apps"

# Copy AppImage scaffolding.
cp "${REPO_ROOT}/packaging/linux/appimage/AppRun"          "${APPIMAGE_STAGING}/AppRun"
cp "${REPO_ROOT}/packaging/linux/appimage/friday.desktop"  "${APPIMAGE_STAGING}/friday.desktop"

chmod 0755 "${APPIMAGE_STAGING}/AppRun"

# Copy icon if present.
if [ -f "${REPO_ROOT}/packaging/linux/appimage/friday.png" ]; then
  cp "${REPO_ROOT}/packaging/linux/appimage/friday.png" \
     "${APPIMAGE_STAGING}/usr/share/icons/hicolor/256x256/apps/friday.png"
  cp "${REPO_ROOT}/packaging/linux/appimage/friday.png" \
     "${APPIMAGE_STAGING}/friday.png"
fi

# Copy the built Friday runtime into the AppImage tree.
if [ -d "${DIST_DIR}/friday-runtime" ]; then
  cp -a "${DIST_DIR}/friday-runtime/." "${APPIMAGE_STAGING}/usr/"
else
  echo "Warning: dist/friday-runtime not found — AppDir will contain scaffolding only."
fi

echo "Built AppImage directory: ${APPIMAGE_STAGING}"
echo ""
echo "To produce a final .AppImage file, run:"
echo "  appimagetool ${APPIMAGE_STAGING} ${DIST_DIR}/Friday-${FRIDAY_VERSION}-x86_64.AppImage"

# ─── Summary ───

echo ""
echo "=== Linux package build complete ==="
echo "  .deb:     ${DEB_OUT}"
echo "  AppDir:   ${APPIMAGE_STAGING}"
echo "  Version:  ${FRIDAY_VERSION}"
