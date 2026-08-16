/**
 * Prepares the unpacked WCDB host bundle for packaged builds.
 *
 * Since 0.9.3 the WCDB host runs in pure Node mode (ELECTRON_RUN_AS_NODE=1):
 * plain Node cannot read app.asar, so the host script and its native
 * dependency (koffi, N-API) must live outside the asar, under
 * resources/host/. electron-builder copies this directory via extraResources
 * (win + mac: "resources/host" -> "host").
 *
 * Run after `vite build`, before `electron-builder`.
 */
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

function copyIfDifferent(sourcePath, targetPath) {
  const source = fs.statSync(sourcePath);
  const targetExists = fs.existsSync(targetPath);
  if (targetExists) {
    const target = fs.statSync(targetPath);
    if (target.size === source.size && target.mtimeMs >= source.mtimeMs) {
      return false;
    }
  }
  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

function copyDirRecursive(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  let copiedCount = 0;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copiedCount += copyDirRecursive(sourcePath, targetPath);
    } else if (copyIfDifferent(sourcePath, targetPath)) {
      copiedCount += 1;
    }
  }
  return copiedCount;
}

function main() {
  const hostDir = path.join(projectRoot, 'resources', 'host');
  const hostScript = path.join(projectRoot, 'dist-electron', 'wcdbHost.js');
  if (!fs.existsSync(hostScript)) {
    console.warn('[prepare-host-bundle] dist-electron/wcdbHost.js not found; run vite build first. Skipping.');
    return;
  }

  fs.mkdirSync(hostDir, { recursive: true });

  let copied = 0;
  if (copyIfDifferent(hostScript, path.join(hostDir, 'wcdbHost.js'))) {
    copied += 1;
  }

  // koffi 及其平台二进制放 host/libs（不能用 node_modules 目录名：
  // electron-builder 的 extraResources 复制过滤器会硬排除根级 node_modules）。
  // 宿主进程以 NODE_PATH=<resources>/host/libs 启动（见 wcdbHostClient.ts）。
  const koffiSource = path.join(projectRoot, 'node_modules', 'koffi');
  const koffiTarget = path.join(hostDir, 'libs', 'koffi');
  if (fs.existsSync(koffiSource)) {
    copied += copyDirRecursive(koffiSource, koffiTarget);
  } else {
    console.warn('[prepare-host-bundle] node_modules/koffi not found; run npm install first. Skipping koffi.');
  }

  // koffi 3.x 的原生二进制走 optionalDependencies（@koromix/koffi-<platform>-<arch>），
  // koffi 按自身 __dirname 相对解析（../../../@koromix），必须与 koffi 包同层放置
  const koromixSource = path.join(projectRoot, 'node_modules', '@koromix');
  const koromixTarget = path.join(hostDir, 'libs', '@koromix');
  if (fs.existsSync(koromixSource)) {
    copied += copyDirRecursive(koromixSource, koromixTarget);
  } else {
    console.warn('[prepare-host-bundle] node_modules/@koromix not found; run npm install first. Skipping platform binaries.');
  }

  if (copied > 0) {
    console.log(`[prepare-host-bundle] synced WCDB host bundle (${copied} file(s)) to resources/host`);
  }
}

main();
